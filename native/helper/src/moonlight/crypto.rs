//! The crypto layer moonlight-common-c expects (PlatformCrypto.h), in Rust.
//!
//! The protocol needs AES-128-GCM (12 or 16 byte IV, 16 byte tag, no extra
//! data) for control, RTSP and video, and AES-128-CBC for audio and for input
//! on old hosts. A context is an opaque pointer to the C side.

use std::os::raw::{c_int, c_uchar};

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use aes::Aes128;
use aes_gcm::aead::consts::{U12, U16};
use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{AesGcm, Nonce, Tag};
use rand::RngCore;

const ALGORITHM_AES_CBC: c_int = 1;
const ALGORITHM_AES_GCM: c_int = 2;

const CIPHER_FLAG_RESET_IV: c_int = 0x01;
const CIPHER_FLAG_FINISH: c_int = 0x02;
const CIPHER_FLAG_PAD_TO_BLOCK_SIZE: c_int = 0x04;

/// Chained IV for streaming CBC encryption, as OpenSSL keeps it between calls.
pub struct CryptoContext {
    cbc_iv: Option<[u8; 16]>,
}

type Gcm12 = AesGcm<Aes128, U12>;
type Gcm16 = AesGcm<Aes128, U16>;
type CbcEnc = cbc::Encryptor<Aes128>;
type CbcDec = cbc::Decryptor<Aes128>;

unsafe fn slice<'a>(p: *const c_uchar, len: c_int) -> &'a [u8] {
    if p.is_null() || len <= 0 {
        &[]
    } else {
        std::slice::from_raw_parts(p, len as usize)
    }
}

unsafe fn slice_mut<'a>(p: *mut c_uchar, len: c_int) -> &'a mut [u8] {
    if p.is_null() || len <= 0 {
        &mut []
    } else {
        std::slice::from_raw_parts_mut(p, len as usize)
    }
}

fn gcm_encrypt(key: &[u8], iv: &[u8], data: &mut [u8]) -> Option<[u8; 16]> {
    let tag = match iv.len() {
        12 => Gcm12::new_from_slice(key).ok()?.encrypt_in_place_detached(Nonce::from_slice(iv), b"", data).ok()?,
        16 => Gcm16::new_from_slice(key)
            .ok()?
            .encrypt_in_place_detached(aes_gcm::aead::generic_array::GenericArray::from_slice(iv), b"", data)
            .ok()?,
        _ => return None,
    };
    let mut out = [0u8; 16];
    out.copy_from_slice(&tag);
    Some(out)
}

fn gcm_decrypt(key: &[u8], iv: &[u8], tag: &[u8], data: &mut [u8]) -> bool {
    if tag.len() != 16 {
        return false;
    }
    let tag = Tag::from_slice(tag);
    match iv.len() {
        12 => Gcm12::new_from_slice(key)
            .map(|c| c.decrypt_in_place_detached(Nonce::from_slice(iv), b"", data, tag).is_ok())
            .unwrap_or(false),
        16 => Gcm16::new_from_slice(key)
            .map(|c| {
                c.decrypt_in_place_detached(aes_gcm::aead::generic_array::GenericArray::from_slice(iv), b"", data, tag)
                    .is_ok()
            })
            .unwrap_or(false),
        _ => false,
    }
}

#[no_mangle]
pub extern "C" fn PltCreateCryptoContext() -> *mut CryptoContext {
    Box::into_raw(Box::new(CryptoContext { cbc_iv: None }))
}

#[no_mangle]
pub unsafe extern "C" fn PltDestroyCryptoContext(ctx: *mut CryptoContext) {
    if !ctx.is_null() {
        drop(Box::from_raw(ctx));
    }
}

#[no_mangle]
pub unsafe extern "C" fn PltGenerateRandomData(data: *mut c_uchar, length: c_int) {
    rand::thread_rng().fill_bytes(slice_mut(data, length));
}

#[no_mangle]
pub unsafe extern "C" fn PltEncryptMessage(
    ctx: *mut CryptoContext,
    algorithm: c_int,
    flags: c_int,
    key: *const c_uchar,
    key_length: c_int,
    iv: *const c_uchar,
    iv_length: c_int,
    tag: *mut c_uchar,
    tag_length: c_int,
    input: *mut c_uchar,
    input_length: c_int,
    output: *mut c_uchar,
    output_length: *mut c_int,
) -> bool {
    let key = slice(key, key_length);
    let iv = slice(iv, iv_length);
    if key.len() != 16 || output.is_null() || output_length.is_null() {
        return false;
    }

    if algorithm == ALGORITHM_AES_GCM {
        let plain = slice(input, input_length);
        let out = slice_mut(output, input_length);
        out.copy_from_slice(plain);
        let Some(t) = gcm_encrypt(key, iv, out) else { return false };
        let tag_out = slice_mut(tag, tag_length);
        if tag_out.len() > 16 {
            return false;
        }
        tag_out.copy_from_slice(&t[..tag_out.len()]);
        *output_length = input_length;
        return true;
    }

    if algorithm == ALGORITHM_AES_CBC && iv.len() == 16 {
        let ctx = match ctx.as_mut() {
            Some(c) => c,
            None => return false,
        };
        if flags & CIPHER_FLAG_PAD_TO_BLOCK_SIZE != 0 {
            // the caller left room for the padding; the chain continues between calls
            let padded = ((input_length as usize + 15) / 16) * 16;
            let buf = slice_mut(input, padded as c_int);
            let pad = (16 - (input_length as usize % 16)) as u8;
            for b in &mut buf[input_length as usize..] {
                *b = pad;
            }
            let start = if flags & CIPHER_FLAG_RESET_IV != 0 || ctx.cbc_iv.is_none() {
                let mut v = [0u8; 16];
                v.copy_from_slice(iv);
                v
            } else {
                ctx.cbc_iv.unwrap_or([0u8; 16])
            };
            let out = slice_mut(output, padded as c_int);
            let mut prev = start;
            for (i, block) in buf.chunks(16).enumerate() {
                let mut x = [0u8; 16];
                for j in 0..16 {
                    x[j] = block[j] ^ prev[j];
                }
                let mut enc = aes::Block::clone_from_slice(&x);
                use aes::cipher::BlockEncrypt;
                Aes128::new_from_slice(key).map(|c| c.encrypt_block(&mut enc)).ok();
                out[i * 16..i * 16 + 16].copy_from_slice(&enc);
                prev.copy_from_slice(&enc);
            }
            ctx.cbc_iv = Some(prev);
            *output_length = padded as c_int;
            return true;
        }
        // one message with PKCS7 padding
        let plain = slice(input, input_length);
        let padded = ((input_length as usize / 16) + 1) * 16;
        let out = slice_mut(output, padded as c_int);
        let Ok(enc) = CbcEnc::new_from_slices(key, iv) else { return false };
        match enc.encrypt_padded_b2b_mut::<Pkcs7>(plain, out) {
            Ok(ct) => {
                *output_length = ct.len() as c_int;
                let _ = flags & CIPHER_FLAG_FINISH;
                true
            }
            Err(_) => false,
        }
    } else {
        false
    }
}

#[no_mangle]
pub unsafe extern "C" fn PltDecryptMessage(
    _ctx: *mut CryptoContext,
    algorithm: c_int,
    _flags: c_int,
    key: *const c_uchar,
    key_length: c_int,
    iv: *const c_uchar,
    iv_length: c_int,
    tag: *const c_uchar,
    tag_length: c_int,
    input: *const c_uchar,
    input_length: c_int,
    output: *mut c_uchar,
    output_length: *mut c_int,
) -> bool {
    let key = slice(key, key_length);
    let iv = slice(iv, iv_length);
    if key.len() != 16 || output.is_null() || output_length.is_null() {
        return false;
    }
    let cipher = slice(input, input_length);

    if algorithm == ALGORITHM_AES_GCM {
        let out = slice_mut(output, input_length);
        out.copy_from_slice(cipher);
        if !gcm_decrypt(key, iv, slice(tag, tag_length), out) {
            return false;
        }
        *output_length = input_length;
        return true;
    }

    if algorithm == ALGORITHM_AES_CBC && iv.len() == 16 {
        let out = slice_mut(output, input_length);
        let Ok(dec) = CbcDec::new_from_slices(key, iv) else { return false };
        return match dec.decrypt_padded_b2b_mut::<Pkcs7>(cipher, out) {
            Ok(pt) => {
                *output_length = pt.len() as c_int;
                true
            }
            Err(_) => false,
        };
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gcm_round_trip_both_iv_sizes() {
        let key = [7u8; 16];
        for iv_len in [12usize, 16] {
            let iv = vec![3u8; iv_len];
            let mut data = b"hello moonlight, sixteen+ bytes".to_vec();
            let tag = gcm_encrypt(&key, &iv, &mut data).unwrap();
            assert_ne!(&data[..], b"hello moonlight, sixteen+ bytes");
            assert!(gcm_decrypt(&key, &iv, &tag, &mut data));
            assert_eq!(&data[..], b"hello moonlight, sixteen+ bytes");
        }
    }

    #[test]
    fn cbc_through_the_c_interface() {
        unsafe {
            let ctx = PltCreateCryptoContext();
            let key = [1u8; 16];
            let iv = [2u8; 16];
            let mut input = b"thirteen char".to_vec();
            let mut out = vec![0u8; 32];
            let mut out_len = 0;
            assert!(PltEncryptMessage(ctx, ALGORITHM_AES_CBC, CIPHER_FLAG_FINISH, key.as_ptr(), 16, iv.as_ptr(), 16, std::ptr::null_mut(), 0, input.as_mut_ptr(), input.len() as c_int, out.as_mut_ptr(), &mut out_len));
            assert_eq!(out_len, 16);
            let mut back = vec![0u8; 16];
            let mut back_len = 0;
            assert!(PltDecryptMessage(ctx, ALGORITHM_AES_CBC, CIPHER_FLAG_RESET_IV | CIPHER_FLAG_FINISH, key.as_ptr(), 16, iv.as_ptr(), 16, std::ptr::null(), 0, out.as_ptr(), 16, back.as_mut_ptr(), &mut back_len));
            assert_eq!(&back[..back_len as usize], b"thirteen char");
            PltDestroyCryptoContext(ctx);
        }
    }
}

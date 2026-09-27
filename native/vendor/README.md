# Vendored sources

- `moonlight-common-c`: the Moonlight streaming protocol (GPLv3), from
  https://github.com/moonlight-stream/moonlight-common-c with its ENet and
  nanors (Reed-Solomon) submodules. Docs, tests and CI files are left out.
  The native helper builds it with `cc` (`native/helper/build.rs`); its
  OpenSSL crypto layer (`src/PlatformCrypto.c`) is not compiled, the helper
  provides those functions in Rust instead.

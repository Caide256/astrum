//! Builds moonlight-common-c (the Moonlight streaming protocol, GPLv3) with
//! its ENet and Reed-Solomon parts, plus a small C bridge. Its crypto layer
//! (PlatformCrypto.c) is left out: the helper provides those functions in Rust
//! (src/moonlight/crypto.rs), so neither OpenSSL nor mbedTLS is needed.

use std::path::PathBuf;

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("vendor").join("moonlight-common-c");
    let src = root.join("src");
    let enet = root.join("enet");
    let nanors = root.join("nanors");

    let mut build = cc::Build::new();
    build
        .include(&src)
        .include(enet.join("include"))
        .include(&nanors)
        .include(nanors.join("deps"))
        .include(nanors.join("deps").join("obl"))
        .define("HAS_SOCKLEN_T", None)
        .define("HAS_QOS_FLOWID", None)
        .define("HAS_PQOS_FLOWID", None)
        .define("NDEBUG", None)
        .define("_CRT_SECURE_NO_WARNINGS", None)
        .warnings(false);

    for entry in std::fs::read_dir(&src).expect("moonlight-common-c sources") {
        let path = entry.expect("source entry").path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if path.extension().and_then(|e| e.to_str()) == Some("c") && name != "PlatformCrypto.c" {
            build.file(&path);
        }
    }
    for f in ["callbacks.c", "compress.c", "host.c", "list.c", "packet.c", "peer.c", "protocol.c", "win32.c"] {
        build.file(enet.join(f));
    }
    build.file(nanors.join("rs.c"));
    build.file(nanors.join("deps").join("obl").join("oblas_common.c"));
    build.file(nanors.join("deps").join("obl").join("oblas_lite.c"));
    build.file(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("csrc").join("bridge.c"));
    build.compile("moonlight");

    println!("cargo:rustc-link-lib=ws2_32");
    println!("cargo:rustc-link-lib=winmm");
    println!("cargo:rustc-link-lib=qwave");
    println!("cargo:rerun-if-changed=csrc/bridge.c");
    println!("cargo:rerun-if-changed=../vendor/moonlight-common-c/src");
}

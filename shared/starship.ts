/** The Starship release the plugin downloads for the Sandbox terminal; a new one comes with a plugin update. */
export const STARSHIP_VERSION = "1.27.0";

/**
 * Release builds by the host's Node architecture, which the VMs share, with the SHA-256 of each
 * archive pinned with the version: a download that does not match is refused.
 */
export const STARSHIP_BUILDS: Readonly<Record<string, { target: string; sha256: string }>> = {
  x64: { target: "x86_64-unknown-linux-musl", sha256: "10c8eb4cb3b761d9bf59ea828444c2dab36c900b7d69a69e08814b286969df89" },
  arm64: { target: "aarch64-unknown-linux-musl", sha256: "341f5cbf24699fa0b27ec88965ad25f862ea09e15d35a543fd6ffdff1d2aa00d" },
};

/** About the size of each archive, for the setting's description. */
export const STARSHIP_DOWNLOAD_MB = 5;

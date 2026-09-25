const brand = require("./brand.json");

/**
 * electron-builder configuration. Name, app id, icon and the update source
 * come from brand.json, so a rebrand is one file. Installer file names have
 * no spaces: GitHub replaces spaces in release asset names with dots, and the
 * updater looks for the exact name written into latest.yml.
 */

const fileName = brand.name.replace(/[^\w.-]+/g, "-");
const [owner, repo] = String(brand.updateRepo || "").split("/");

module.exports = {
  appId: brand.appId,
  productName: brand.name,
  copyright: brand.publisher ? `© ${brand.publisher}` : undefined,
  icon: brand.logo,
  // the packed package.json gets the brand name: Electron derives the data folder from it
  extraMetadata: { productName: brand.name, description: brand.description },
  files: ["dist/**", "electron/**", "brand.json", brand.logo, "package.json"],
  directories: { output: "release" },
  win: {
    target: ["nsis", "portable"],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: brand.name,
    uninstallDisplayName: brand.name,
    artifactName: `${fileName}-Setup-\${version}.\${ext}`,
  },
  portable: {
    artifactName: `${fileName}-\${version}-portable.\${ext}`,
  },
  linux: {
    target: ["AppImage"],
    category: "Network",
  },
  // latest.yml is written for the updater; nothing is uploaded by the build itself
  publish: owner && repo ? [{ provider: "github", owner, repo }] : null,
  // the helper is named after the product, so Task Manager shows whose it is
  extraResources: [
    {
      from: "native/helper/target/release/native-helper.exe",
      to: `${fileName}-helper.exe`,
    },
  ],
};

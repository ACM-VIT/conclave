const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const fs = require("fs");
const path = require("path");

const config = getDefaultConfig(__dirname);
const isCI = process.env.CI === "1" || process.env.CI === "true";
const workspaceRoot = path.resolve(__dirname, "../..");
const appsSdkPath = path.resolve(workspaceRoot, "packages/apps-sdk");
const meetingCorePath = path.resolve(workspaceRoot, "packages/meeting-core");
const workspaceNodeModulesPath = path.resolve(workspaceRoot, "node_modules");
const isomorphicWebcryptoShimPackagePath = path.resolve(
  __dirname,
  "src/shims/isomorphic-webcrypto"
);
const eventTargetShimCandidates = [
  path.resolve(__dirname, "node_modules/react-native-webrtc/node_modules/event-target-shim"),
  path.resolve(workspaceNodeModulesPath, "react-native-webrtc/node_modules/event-target-shim"),
  path.resolve(__dirname, "node_modules/event-target-shim"),
  path.resolve(workspaceNodeModulesPath, "event-target-shim"),
];
const eventTargetShimPath =
  eventTargetShimCandidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "index.js"))
  ) ?? eventTargetShimCandidates[0];
const eventTargetShimIndexPath = path.join(eventTargetShimPath, "index.js");
const yjsCjsPath = path.resolve(workspaceNodeModulesPath, "yjs/dist/yjs.cjs");
const yProtocolsPath = path.resolve(workspaceNodeModulesPath, "y-protocols");
const yProtocolsAwarenessCjsPath = path.resolve(
  workspaceNodeModulesPath,
  "y-protocols/dist/awareness.cjs"
);
const yProtocolsSyncCjsPath = path.resolve(
  workspaceNodeModulesPath,
  "y-protocols/dist/sync.cjs"
);
const yProtocolsAuthCjsPath = path.resolve(
  workspaceNodeModulesPath,
  "y-protocols/dist/auth.cjs"
);
const lib0Path = path.resolve(workspaceNodeModulesPath, "lib0");

config.transformer = {
  ...config.transformer,
  babelTransformerPath: require.resolve("react-native-svg-transformer"),
};
config.resolver = {
  ...config.resolver,
  assetExts: config.resolver.assetExts.filter((ext) => ext !== "svg"),
  sourceExts: [...config.resolver.sourceExts, "svg"],
  extraNodeModules: {
    ...(config.resolver.extraNodeModules ?? {}),
    "@conclave/apps-sdk": path.join(appsSdkPath, "src/index.ts"),
    "@conclave/meeting-core": path.join(meetingCorePath, "src/index.ts"),
    "@conclave/meeting-core/chat-commands": path.join(
      meetingCorePath,
      "src/chat-commands.ts"
    ),
    "@conclave/meeting-core/participant-reducer": path.join(
      meetingCorePath,
      "src/participant-reducer.ts"
    ),
    "@conclave/meeting-core/sfu-types": path.join(
      meetingCorePath,
      "src/sfu-types.ts"
    ),
    "@conclave/meeting-core/types": path.join(
      meetingCorePath,
      "src/types.ts"
    ),
    "@conclave/meeting-core/video-encodings": path.join(
      meetingCorePath,
      "src/video-encodings.ts"
    ),
    "event-target-shim": eventTargetShimPath,
    "event-target-shim/index": eventTargetShimIndexPath,
    "isomorphic-webcrypto": isomorphicWebcryptoShimPackagePath,
    yjs: yjsCjsPath,
    "yjs/dist/yjs.mjs": yjsCjsPath,
    "yjs/dist/yjs.cjs": yjsCjsPath,
    "y-protocols": yProtocolsPath,
    "y-protocols/awareness": yProtocolsAwarenessCjsPath,
    "y-protocols/sync": yProtocolsSyncCjsPath,
    "y-protocols/auth": yProtocolsAuthCjsPath,
    lib0: lib0Path,
  },
  nodeModulesPaths: [
    path.resolve(__dirname, "node_modules"),
    workspaceNodeModulesPath,
  ],
  disableHierarchicalLookup: true,
};

config.watchFolders = [appsSdkPath, meetingCorePath, workspaceNodeModulesPath];

module.exports = withNativeWind(config, {
  input: "./src/global.css",
  forceWriteFileSystem: isCI,
});

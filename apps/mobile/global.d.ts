/// <reference types="react-native-webrtc" />

interface MediaStream {
  toURL(): string;
}

declare module "*.png" {
  const content: number;
  export default content;
}

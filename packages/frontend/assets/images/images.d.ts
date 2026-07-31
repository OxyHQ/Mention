declare module "@/assets/images/*" {
  // Metro turns a bundled image into an asset reference, which is exactly what
  // `ImageRequireSource` describes — a number on native, an object on web.
  import type { ImageRequireSource } from "react-native";

  const value: ImageRequireSource;
  export default value;
}

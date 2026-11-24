// Bloom's native source compiled by the React Compiler.
//
// On Android and iOS Metro resolves `@oxy.so/bloom` through its `react-native`
// export condition to `src/`, and babel-preset-expo runs the React Compiler on
// app code only (it skips node_modules), so none of Bloom's components were
// memoized. This override compiles Bloom's and Bloom Data's source with the
// compiler Expo already runs, with the options it gives app code, which are
// also the ones Bloom's own build uses (Bloom's babel.build.cjs): target 19,
// errors leave the function as written, function outlining on, and `sources`
// widened because the compiler skips node_modules by default. It needs a Bloom
// with #889's opt-outs (Bloom 23.5.0) whose components are all defined at
// module scope (OxyHQ/Bloom#910): the compiler takes the parameters of a
// function a component is built inside for globals, and outlining moved a
// lambda out of Bloom's factory-built SettingsSelect (`SelectItem is not
// defined`). Bloom Data needs #911: compiled, its useArgs dropped the memo
// that holds a list's arguments, so useList observed its source again on
// every render (a feed asked its service in a loop). The same
// options then compile Bloom whether it is a package here or a local checkout
// (OXY_LOCAL_CHECKOUT_SOURCES, where Bloom's source is app code to the preset).
//
// The Bloom language is left out: its hosts call app bodies that call hooks,
// and a memoized call skipped them. Bloom Lens ships source the compiler has
// not been checked against.
//
// Every other file resolves to babel-preset-expo alone, so Expo's
// default-config check (resolved per file) keeps app code on Noxcturnal in
// development.
const BLOOM_SOURCE = /[\\/]node_modules[\\/]@oxy\.so[\\/](bloom|bloom-data)[\\/]src[\\/]/;

const REACT_COMPILER = require.resolve('babel-plugin-react-compiler', {
  paths: [require.resolve('babel-preset-expo')],
});

module.exports = (api) => {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    overrides: [
      {
        test: (filename) => filename != null && BLOOM_SOURCE.test(filename),
        plugins: [
          [
            REACT_COMPILER,
            {
              target: '19',
              panicThreshold: 'none',
              sources: () => true,
            },
          ],
        ],
      },
    ],
  };
};

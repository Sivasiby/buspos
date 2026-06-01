module.exports = {
  root: true,
  parser: '@babel/eslint-parser',  // ← add this
  parserOptions: {
    requireConfigFile: false,       // ← add this
    babelOptions: {
      plugins: [
        ['@babel/plugin-proposal-decorators', { legacy: true }]
      ],
    },
  },
  extends: '@react-native',
};
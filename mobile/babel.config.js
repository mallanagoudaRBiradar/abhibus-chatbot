// babel-preset-expo (SDK 54+) wires the Reanimated 4 / Worklets plugin automatically.
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};

export default {
  plugins: {
    "postcss-px-to-viewport": {
      viewportWidth: 375,
      unitPrecision: 6,
      unitToConvert: "px",
      viewportUnit: "vmin",
      fontViewportUnit: "vmin",
      propList: ["*"],
    },
  },
}

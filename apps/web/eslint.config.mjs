import next from "eslint-config-next";

export default [
  ...next,
  {
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "TSAsExpression > TSAnyKeyword", message: "No `as any`." },
      ],
    },
  },
];

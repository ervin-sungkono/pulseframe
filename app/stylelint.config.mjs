export default {
  extends: ["stylelint-config-standard"],
  rules: {
    "at-rule-no-unknown": [true, { ignoreAtRules: ["theme"] }],
    "selector-class-pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
    "rule-empty-line-before": ["always-multi-line", { except: ["first-nested"] }],
  },
};

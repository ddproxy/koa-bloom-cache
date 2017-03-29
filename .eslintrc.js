module.exports = {
  "extends": "standard",
  "plugins": [
    "standard",
    "promise"
  ],
  'rules': {
    'quotes': 0,
    'arrow-parens': 0,
    'generator-star-spacing': 0,
    'no-debugger': process.env.NODE_ENV === 'production' ? 2 : 0,
    'semi': ["error", "always"]
  }
};
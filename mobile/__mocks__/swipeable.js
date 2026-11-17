// Jest stand-in for ReanimatedSwipeable (Reanimated worklets don't run in
// Jest): renders the row plus both action panels so tests can press them.
const React = require('react');
const { View } = require('react-native');

function ReanimatedSwipeable({ children, renderLeftActions, renderRightActions }) {
  const methods = { close: () => undefined, openLeft: () => undefined, openRight: () => undefined, reset: () => undefined };
  return React.createElement(
    View,
    null,
    renderLeftActions ? renderLeftActions(null, null, methods) : null,
    children,
    renderRightActions ? renderRightActions(null, null, methods) : null,
  );
}

module.exports = ReanimatedSwipeable;
module.exports.default = ReanimatedSwipeable;

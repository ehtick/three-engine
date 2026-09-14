import { Component } from '../../engine/components/Component.js';

/** Persistent semantic ownership. Native child components remain ordinary
 * editable providers and their scene data is a regenerable product cache. */
export class WorldFeatureComponent extends Component {
  static type = 'world-feature';
  static label = 'World feature';
  static internal = true;
  static defaults = { key: '', provider: '', generatedTransform: null };
  static schema = [];
  onPropChanged() {}
}

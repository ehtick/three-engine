import { WorldComponent } from './WorldComponent.js';
import { WorldFeatureComponent } from './WorldFeatureComponent.js';

export const worldModule = {
  id:'world', name:'World', version:'1.0.0', category:'World',
  description:'Generate and art-direct a temperate valley with shared terrain, water, vegetation, buildings and sky.',
  tags:['world','terrain','foliage','architecture','water','atmosphere'],
  requires:['terrain','water','foliage','architecture','atmosphere'],
  components:[WorldComponent, WorldFeatureComponent],
  setup(engine) {
    for (const entity of engine.entities.values()) {
      const component = entity.getComponent('world');
      if (component?.missingType) { const props = component.props; entity.removeComponent('world'); entity.addComponent('world',props); }
      else if (component && !component._alive && component._attached !== false) component.onAttach();
    }
    return { dispose() { for (const entity of engine.entities.values()) { const component = entity.getComponent('world'); if (component?._alive) component.onDetach(); } } };
  },
};
export { WorldComponent, WorldFeatureComponent };

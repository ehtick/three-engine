import { engine } from "../engineInstance.js";
import { getComponentClass } from "../../engine/index.js";

export class AddComponentCommand {
  constructor(entityId, type, props = {}) {
    this.entityId = entityId;
    this.type = type;
    this.props = props;
    this.label = `Add ${getComponentClass(type)?.label ?? type}`;
  }

  do() {
    engine.getEntity(this.entityId)?.addComponent(this.type, this.props);
  }

  undo() {
    engine.getEntity(this.entityId)?.removeComponent(this.type);
  }
}

export class RemoveComponentCommand {
  constructor(entityId, type) {
    this.entityId = entityId;
    this.type = type;
    const component = engine.getEntity(entityId)?.getComponent(type);
    this.props = component ? { ...component.props } : {};
    this.label = `Remove ${getComponentClass(type)?.label ?? type}`;
  }

  do() {
    engine.getEntity(this.entityId)?.removeComponent(this.type);
  }

  undo() {
    engine.getEntity(this.entityId)?.addComponent(this.type, this.props);
  }
}

export class SetComponentPropCommand {
  /** `label` overrides the undo-history entry — useful when one prop backs
   *  several distinct user actions (the scripts list is added to, reordered,
   *  toggled and removed from, all by writing `scripts`). */
  constructor(entityId, type, key, value, label) {
    this.entityId = entityId;
    this.type = type;
    this.key = key;
    this.value = value;
    this.oldValue = engine.getEntity(entityId)?.getComponent(type)?.props[key];
    this.label = label ?? `Set ${key}`;
  }

  do() {
    engine.getEntity(this.entityId)?.getComponent(this.type)?.setProp(this.key, this.value);
  }

  undo() {
    engine.getEntity(this.entityId)?.getComponent(this.type)?.setProp(this.key, this.oldValue);
  }
}

import { memo, useEffect } from "react";
import { Handle, Position, NodeResizer, useUpdateNodeInternals } from "@xyflow/react";
import { ChevronDown, ChevronRight, Eye } from "lucide-react";
import { AssetField } from "../fields/AssetField.jsx";
import { socketColor } from "./socketTypes.js";
import { FRAME_TYPE, REROUTE_TYPE } from "./graphUtils.js";
import {
  NumberField,
  Vec3Field,
  ColorField,
  SelectField,
  BoolField,
  CurveField,
  GradientField,
} from "./fields/GraphFields.jsx";

/**
 * Shared node chrome for every graph editor in the app.
 *
 * Registry-agnostic by design: the shader registry (`tslGraph.js`) and the
 * particle registry (`particleGraph.js`) describe nodes differently (`cat` vs
 * `category`, string outputs vs `{key,label}` outputs, inline input defaults vs
 * params-only). Rather than force one shape on both — which would mean editing
 * two compilers to fix a UI problem — each panel supplies a `describe(type)`
 * adapter through `node.data`, and this component renders the normalized
 * result:
 *
 *   { label, cat, inputs: [{key,label,type,editable,default}],
 *     outputs: [{key,label,type}],
 *     params:  [{key,label,type,default,min,max,step,options,exts}] }
 */

/** One param/input widget. `onChange(value, gesture)` — `gesture` true while a
 *  drag is mid-flight so the editor can coalesce undo and skip recompiles. */
function Widget({ spec, value, onChange }) {
  const v = value ?? spec.default;
  switch (spec.type) {
    case "number":
    case "float":
      return <NumberField value={v ?? 0} step={spec.step ?? 0.05} min={spec.min} max={spec.max} onChange={onChange} />;
    case "vec3":
      return <Vec3Field value={v} step={spec.step ?? 0.1} onChange={onChange} />;
    case "color":
      return <ColorField value={v ?? "#ffffff"} onChange={onChange} />;
    case "boolean":
      return <BoolField value={!!v} onChange={onChange} />;
    case "select":
      return <SelectField value={v} options={spec.options ?? []} onChange={onChange} />;
    // A one-line string. `code` already existed for multi-line expressions, but
    // a textarea for a method name or an input action reads as "write some code
    // here" and takes three rows to do it. Added for the event graph, where
    // most fields are short strings.
    case "string":
    case "text":
      return (
        <input
          type="text"
          className="gf-text nodrag nopan"
          spellCheck={false}
          placeholder={spec.placeholder ?? ""}
          value={v ?? ""}
          onChange={(e) => onChange(e.target.value, true)}
          onBlur={(e) => onChange(e.target.value, false)}
        />
      );
    case "curve":
      return <CurveField value={v} yMin={spec.min ?? 0} yMax={spec.max ?? 1} onChange={onChange} />;
    case "gradient":
      return <GradientField value={v} onChange={onChange} />;
    case "asset":
      return (
        <div className="gf-asset nodrag nopan">
          <AssetField descriptor={{ exts: spec.exts }} value={v ?? ""} onCommit={(path) => onChange(path, false)} />
        </div>
      );
    case "code":
      return (
        <textarea
          className="gf-code nodrag nopan"
          spellCheck={false}
          rows={spec.rows ?? 4}
          placeholder={spec.placeholder ?? "a.mul(b)"}
          value={v ?? ""}
          onChange={(e) => onChange(e.target.value, true)}
          onBlur={(e) => onChange(e.target.value, false)}
        />
      );
    default:
      return null;
  }
}

function GraphNodeInner({ id, data, selected }) {
  const def = data.describe(data.nodeType);
  const updateNodeInternals = useUpdateNodeInternals();

  const props = data.props ?? {};
  const collapsed = !!props.__collapsed;
  const thumb = !!props.__thumb;
  const wired = data.connectedHandles;
  const inputs = def?.inputs ?? [];
  const outputs = def?.outputs ?? [];
  const params = def?.params ?? [];
  const set = (key, value, gesture) => data.onPropsChange(id, { [key]: value }, { gesture, param: key });
  const multiOut = outputs.length > 1;

  // Preview / collapse remounts content and moves handles — RF only remeasures
  // when asked, otherwise the wrapper keeps the previous box and the node
  // looks like a hollow shell (Texture with the eye off is the usual case).
  useEffect(() => {
    const raf = requestAnimationFrame(() => updateNodeInternals(id));
    return () => cancelAnimationFrame(raf);
  }, [id, thumb, collapsed, updateNodeInternals]);

  if (!def) return null;

  // Collapsed nodes keep every handle mounted but stack them on the header
  // edge. React Flow drops edges whose handle element has unmounted, so
  // hiding them outright would silently delete the user's wiring.
  const handleStyle = collapsed ? { top: 14 } : undefined;

  const outputPorts = multiOut && (
    <div className="node-output-ports">
      {outputs.map((o) => (
        <div className="shader-node-row out-row" key={`out-${o.key}`}>
          <span className="shader-port-label out">{o.label ?? o.key}</span>
          <Handle
            type="source"
            position={Position.Right}
            id={o.key}
            className="shader-handle"
            style={{ background: socketColor(o.type) }}
          />
        </div>
      ))}
    </div>
  );

  return (
    <div
      className={`shader-node graph-node cat-${def.cat}${selected ? " selected" : ""}${collapsed ? " collapsed" : ""}${thumb ? " has-thumb" : ""}`}
    >
      <div className="shader-node-header">
        <button
          className="graph-node-collapse nodrag"
          title={collapsed ? "Expand" : "Collapse"}
          onClick={() => set("__collapsed", !collapsed, false)}
        >
          {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        </button>
        <span className="shader-node-dot" />
        <span className="shader-node-label">{def.label}</span>
        {data.canPreview && !def.noPreview && (
          <button
            className={`node-thumb-toggle nodrag${thumb ? " active" : ""}`}
            title="Toggle preview"
            onClick={() => set("__thumb", !thumb, false)}
          >
            <Eye size={11} />
          </button>
        )}
        {data.error && (
          <span className="graph-node-error" title={data.error}>
            !
          </span>
        )}
        {/* Single-output nodes put their port on the header row — the common
            case, and it keeps short nodes to one line when collapsed. */}
        {outputs.length === 1 && (
          <Handle
            type="source"
            position={Position.Right}
            id={outputs[0].key}
            className="shader-handle"
            style={{ ...handleStyle, background: socketColor(outputs[0].type) }}
          />
        )}
      </div>

      {collapsed && (
        <>
          {inputs.map((spec, k) => (
            <Handle
              key={spec.key}
              type="target"
              position={Position.Left}
              id={spec.key}
              className="shader-handle"
              style={{ top: 14 + k * 0.001, background: socketColor(spec.type) }}
            />
          ))}
          {multiOut &&
            outputs.map((o, k) => (
              <Handle
                key={o.key}
                type="source"
                position={Position.Right}
                id={o.key}
                className="shader-handle"
                style={{ top: 14 + k * 0.001, background: socketColor(o.type) }}
              />
            ))}
        </>
      )}

      {!collapsed && (
        <div className="shader-node-body">
          {/* Single-output preview stacks above the body. Multi-output
              (Texture / Split) puts it in the same rows as the sockets so
              eye-on grows the node and eye-off leaves only the port stack. */}
          {thumb && !multiOut && (
            <div className="node-thumb nodrag">
              <canvas width={96} height={96} ref={(el) => data.registerThumb?.(id, el)} />
            </div>
          )}

          {multiOut && thumb ? (
            <div className="node-output-group">
              <div className="node-thumb inline nodrag">
                <canvas width={96} height={96} ref={(el) => data.registerThumb?.(id, el)} />
              </div>
              {outputPorts}
            </div>
          ) : (
            outputPorts
          )}

          {inputs.map((spec) => {
            const isWired = wired?.has(spec.key) ?? false;
            return (
              <div className="shader-node-row" key={spec.key} data-wired={isWired || undefined}>
                <Handle
                  type="target"
                  position={Position.Left}
                  id={spec.key}
                  className="shader-handle"
                  style={{ background: socketColor(spec.type) }}
                />
                <span className="shader-port-label">{spec.label ?? spec.key}</span>
                {/* An input's inline editor disappears the moment it's wired:
                    the value would be ignored, and leaving a live-looking
                    control that does nothing is worse than showing none. */}
                {spec.editable && !isWired && (
                  // `widget` overrides `type` for rendering: a socket typed
                  // `any` can still need a colour picker, and the shader
                  // registry infers that from the input's default value.
                  <Widget
                    spec={{ ...spec, type: spec.widget ?? spec.type }}
                    value={props[spec.key]}
                    onChange={(v, g) => set(spec.key, v, g)}
                  />
                )}
              </div>
            );
          })}

          {params.map((p) => (
            <div className={`shader-node-row field nodrag${p.type === "code" ? " code-field" : ""}`} key={p.key}>
              {p.label && p.type !== "code" && <span className="shader-port-label param-label">{p.label}</span>}
              <Widget spec={p} value={props[p.key]} onChange={(v, g) => set(p.key, v, g)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const GraphNode = memo(GraphNodeInner);

/**
 * Comment frame: a titled, resizable rectangle drawn behind the nodes it
 * contains. Purely an authoring aid — `GraphEditor` strips frames before
 * handing a graph to a compiler, and drags every node inside one along with it.
 */
function FrameNodeInner({ id, data, selected }) {
  const props = data.props ?? {};
  return (
    <div className="graph-frame" style={{ borderColor: props.color ?? "#4d9dff" }}>
      <NodeResizer minWidth={160} minHeight={110} isVisible={selected} lineClassName="graph-frame-resize" />
      <input
        className="graph-frame-title nodrag nopan"
        value={props.title ?? "Comment"}
        placeholder="Comment"
        spellCheck={false}
        style={{ color: props.color ?? "#4d9dff" }}
        onChange={(e) => data.onPropsChange(id, { title: e.target.value }, { gesture: true, param: "title" })}
        onBlur={(e) => data.onPropsChange(id, { title: e.target.value }, { param: "title" })}
      />
    </div>
  );
}

export const FrameNode = memo(FrameNodeInner);

/**
 * Reroute pin: a bare dot with one in and one out, used to route a long wire
 * around the middle of a graph. Both compilers resolve it by following the
 * wire through (see each panel's `stripHelpers`), so it never reaches a
 * registry.
 */
function RerouteNodeInner({ data, selected }) {
  const color = socketColor(data.socketType ?? "any");
  return (
    <div className={`graph-reroute${selected ? " selected" : ""}`} style={{ borderColor: color }}>
      <Handle type="target" position={Position.Left} id="in" className="shader-handle" style={{ background: color }} />
      <Handle type="source" position={Position.Right} id="out" className="shader-handle" style={{ background: color }} />
    </div>
  );
}

export const RerouteNode = memo(RerouteNodeInner);

/** Node types every graph editor registers, on top of its own domain nodes. */
export const sharedNodeTypes = {
  graphNode: GraphNode,
  [FRAME_TYPE]: FrameNode,
  [REROUTE_TYPE]: RerouteNode,
};

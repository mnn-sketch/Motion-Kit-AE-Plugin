/*
    Motion Kit — dockable ScriptUI panel for After Effects
    Install: copy this file into
      /Applications/Adobe After Effects <version>/Scripts/ScriptUI Panels/
    then restart AE and open it from Window > Motion Kit.jsx

    Tools
      Bounce   — one-click inertial bounce expression (amp / freq / decay)
      Ease     — ease in / ease out influence on selected keyframes
      Align    — align layers to the comp or to the selection
      Anchor   — move the anchor point to a 3x3 grid position without moving the layer
      Stagger  — offset selected layers in time, one step per layer, like a stair
*/
(function motionKit(thisObj) {
    var NAME = "Motion Kit";
    var BOUNCE_TAG = "// MotionKit bounce";
    var FX_AMP = "Bounce Amplitude", FX_FREQ = "Bounce Frequency", FX_DECAY = "Bounce Decay";

    // ---------------------------------------------------------------- helpers

    function activeComp() {
        var c = app.project.activeItem;
        if (!(c && c instanceof CompItem)) {
            alert("Open a composition first.", NAME);
            return null;
        }
        return c;
    }

    function undoable(label, fn) {
        app.beginUndoGroup(NAME + ": " + label);
        try { fn(); }
        catch (e) { alert(e.toString() + (e.line ? " (line " + e.line + ")" : ""), NAME); }
        finally { app.endUndoGroup(); }
    }

    function readNum(field, fallback) {
        var v = parseFloat(field.text);
        if (isNaN(v)) { field.text = String(fallback); return fallback; }
        return v;
    }

    function addV(a, b) {
        if (!(a instanceof Array)) return a + (b instanceof Array ? b[0] : b);
        var out = [];
        for (var i = 0; i < a.length; i++) out.push(a[i] + (i < b.length ? b[i] : 0));
        return out;
    }

    function subV(a, b) {
        var out = [];
        for (var i = 0; i < a.length; i++) out.push(a[i] - (i < b.length ? b[i] : 0));
        return out;
    }

    // Adding effects invalidates property references on a layer, so we store
    // index paths and resolve them again afterwards.
    function propPath(p) {
        var path = [];
        while (p.propertyDepth > 0) {
            path.unshift(p.propertyIndex);
            p = p.parentProperty;
        }
        return { layer: p, path: path };
    }

    function resolvePath(ref) {
        var p = ref.layer;
        for (var i = 0; i < ref.path.length; i++) p = p.property(ref.path[i]);
        return p;
    }

    function selectedLeafProps(comp) {
        var out = [], sp = comp.selectedProperties;
        for (var i = 0; i < sp.length; i++) {
            if (sp[i].propertyType === PropertyType.PROPERTY) out.push(sp[i]);
        }
        return out;
    }

    // Layers that have a source rect and effects. Note: `instanceof AVLayer`
    // is false for shape and text layers in ExtendScript, so exclude cameras
    // and lights instead.
    function selectedAVLayers(comp) {
        var out = [], sel = comp.selectedLayers, locked = 0;
        for (var i = 0; i < sel.length; i++) {
            var L = sel[i];
            if (L instanceof CameraLayer || L instanceof LightLayer) continue;
            if (L.locked) { locked++; continue; }
            out.push(L);
        }
        if (!out.length) {
            alert(locked ? "The selected layers are locked. Unlock them first." : "Select one or more layers.", NAME);
        }
        return out;
    }

    function walkProps(group, fn) {
        for (var i = 1; i <= group.numProperties; i++) {
            var p = group.property(i);
            if (p.propertyType === PropertyType.PROPERTY) fn(p);
            else walkProps(p, fn);
        }
    }

    // Evaluate an expression in the context of a layer by putting it on a
    // temporary 3D Point Control, reading the result, and removing the effect.
    function evalOnLayer(layer, expr, t) {
        var fx = layer.property("ADBE Effect Parade").addProperty("ADBE Point3D Control");
        var prop = fx.property(1);
        prop.expression = expr;
        var v = prop.valueAtTime(t, false);
        fx.remove();
        return v;
    }

    // Shift a property (whole animation, if keyframed) by a delta.
    function offsetProp(prop, delta) {
        if (prop.numKeys === 0) {
            prop.setValue(addV(prop.value, delta));
        } else {
            for (var k = 1; k <= prop.numKeys; k++) {
                prop.setValueAtKey(k, addV(prop.keyValue(k), delta));
            }
        }
    }

    function offsetPosition(layer, delta) {
        var tr = layer.property("ADBE Transform Group");
        var pos = tr.property("ADBE Position");
        if (pos.dimensionsSeparated) {
            offsetProp(tr.property("ADBE Position_0"), delta[0]);
            offsetProp(tr.property("ADBE Position_1"), delta[1]);
            if (layer.threeDLayer && delta.length > 2) offsetProp(tr.property("ADBE Position_2"), delta[2]);
        } else {
            offsetProp(pos, delta);
        }
    }

    function currentPosition(layer, t) {
        var v = layer.property("ADBE Transform Group").property("ADBE Position").valueAtTime(t, false);
        return [v[0], v[1], v.length > 2 ? v[2] : 0];
    }

    // Comp-space bounding box of a layer (handles scale, rotation, parenting).
    function compBounds(layer, t) {
        var body =
            "var r = sourceRectAtTime(time, false);" +
            "var c = [toComp([r.left, r.top]), toComp([r.left + r.width, r.top])," +
            "         toComp([r.left, r.top + r.height]), toComp([r.left + r.width, r.top + r.height])];" +
            "var x0 = c[0][0], x1 = x0, y0 = c[0][1], y1 = y0;" +
            "for (var i = 1; i < 4; i++) {" +
            "  x0 = Math.min(x0, c[i][0]); x1 = Math.max(x1, c[i][0]);" +
            "  y0 = Math.min(y0, c[i][1]); y1 = Math.max(y1, c[i][1]);" +
            "}";
        var a = evalOnLayer(layer, body + "[x0, y0, x1];", t);
        var b = evalOnLayer(layer, body + "[y1, 0, 0];", t);
        return { l: a[0], t: a[1], r: a[2], b: b[0] };
    }

    // ---------------------------------------------------------------- bounce

    function bounceExpression(live, amp, freq, decay) {
        var head = live
            ? 'var amp = effect("' + FX_AMP + '")(1);\n' +
              'var freq = effect("' + FX_FREQ + '")(1);\n' +
              'var decay = effect("' + FX_DECAY + '")(1);\n'
            : "var amp = " + amp + ";\nvar freq = " + freq + ";\nvar decay = " + decay + ";\n";
        return BOUNCE_TAG + "\n" + head + [
            "var n = 0;",
            "var time_max = 4;",
            "if (numKeys > 0) {",
            "  n = nearestKey(time).index;",
            "  if (key(n).time > time) n--;",
            "}",
            "var t = (n == 0) ? 0 : time - key(n).time;",
            "if (n > 0 && t < time_max) {",
            "  var v = velocityAtTime(key(n).time - thisComp.frameDuration / 10);",
            "  add(value, mul(v, amp * Math.sin(freq * t * 2 * Math.PI) / Math.exp(decay * t)));",
            "} else {",
            "  value;",
            "}"
        ].join("\n");
    }

    function ensureSlider(layer, name, val) {
        var parade = layer.property("ADBE Effect Parade");
        var fx = parade.property(name);
        if (!fx) {
            fx = parade.addProperty("ADBE Slider Control");
            fx.name = name;
        }
        if (fx.property(1).numKeys === 0) fx.property(1).setValue(val);
    }

    function applyBounce(amp, freq, decay, live) {
        var comp = activeComp(); if (!comp) return;
        var props = selectedLeafProps(comp), refs = [], skipped = 0;
        for (var i = 0; i < props.length; i++) {
            if (props[i].canSetExpression && props[i].canVaryOverTime) refs.push(propPath(props[i]));
        }
        if (!refs.length) {
            alert("Select one or more keyframed properties (e.g. Position, Scale, Rotation) first.", NAME);
            return;
        }
        undoable("Apply Bounce", function () {
            if (live) {
                var done = {};
                for (var i = 0; i < refs.length; i++) {
                    var L = refs[i].layer;
                    if (done[L.index]) continue;
                    done[L.index] = true;
                    ensureSlider(L, FX_AMP, amp);
                    ensureSlider(L, FX_FREQ, freq);
                    ensureSlider(L, FX_DECAY, decay);
                }
            }
            var expr = bounceExpression(live, amp, freq, decay);
            for (var j = 0; j < refs.length; j++) {
                var p = resolvePath(refs[j]);
                if (p.numKeys < 1) skipped++;
                p.expression = expr;
            }
        });
        if (skipped) alert(skipped + " property(s) have no keyframes yet, so the bounce won't do anything until you add some.", NAME);
    }

    function removeBounce() {
        var comp = activeComp(); if (!comp) return;
        undoable("Remove Bounce", function () {
            var props = selectedLeafProps(comp), i;
            var clear = function (p) {
                if (p.canSetExpression && p.expression.indexOf(BOUNCE_TAG) === 0) p.expression = "";
            };
            if (props.length) {
                for (i = 0; i < props.length; i++) clear(props[i]);
                return;
            }
            // No properties selected: clean whole selected layers, sliders included.
            var layers = comp.selectedLayers;
            for (i = 0; i < layers.length; i++) {
                walkProps(layers[i], clear);
                var parade = layers[i].property("ADBE Effect Parade");
                if (!parade) continue;
                var names = [FX_AMP, FX_FREQ, FX_DECAY];
                for (var n = 0; n < names.length; n++) {
                    var fx = parade.property(names[n]);
                    if (fx) fx.remove();
                }
            }
        });
    }

    // ---------------------------------------------------------------- easing

    function applyEase(inInf, outInf) {
        var comp = activeComp(); if (!comp) return;
        inInf = Math.max(0.1, Math.min(100, inInf));
        outInf = Math.max(0.1, Math.min(100, outInf));
        var props = selectedLeafProps(comp), count = 0;
        undoable("Ease", function () {
            for (var i = 0; i < props.length; i++) {
                var p = props[i];
                if (!p.canVaryOverTime) continue;
                var keys = p.selectedKeys;
                for (var k = 0; k < keys.length; k++) {
                    var idx = keys[k];
                    var dims = p.keyInTemporalEase(idx).length;
                    var easeIn = [], easeOut = [];
                    for (var d = 0; d < dims; d++) {
                        easeIn.push(new KeyframeEase(0, inInf));
                        easeOut.push(new KeyframeEase(0, outInf));
                    }
                    p.setInterpolationTypeAtKey(idx, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
                    p.setTemporalEaseAtKey(idx, easeIn, easeOut);
                    count++;
                }
            }
        });
        if (!count) alert("Select some keyframes first.", NAME);
    }

    // ---------------------------------------------------------------- align

    function alignLayers(mode, toSelection) {
        var comp = activeComp(); if (!comp) return;
        var layers = selectedAVLayers(comp);
        if (!layers.length) return;
        if (toSelection && layers.length < 2) toSelection = false;

        undoable("Align", function () {
            var t = comp.time, i, bounds = [];
            for (i = 0; i < layers.length; i++) bounds.push(compBounds(layers[i], t));

            var target = { l: 0, t: 0, r: comp.width, b: comp.height };
            if (toSelection) {
                target = { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity };
                for (i = 0; i < bounds.length; i++) {
                    target.l = Math.min(target.l, bounds[i].l);
                    target.t = Math.min(target.t, bounds[i].t);
                    target.r = Math.max(target.r, bounds[i].r);
                    target.b = Math.max(target.b, bounds[i].b);
                }
            }

            for (i = 0; i < layers.length; i++) {
                var b = bounds[i], dx = 0, dy = 0;
                switch (mode) {
                    case "left":    dx = target.l - b.l; break;
                    case "hcenter": dx = (target.l + target.r) / 2 - (b.l + b.r) / 2; break;
                    case "right":   dx = target.r - b.r; break;
                    case "top":     dy = target.t - b.t; break;
                    case "vcenter": dy = (target.t + target.b) / 2 - (b.t + b.b) / 2; break;
                    case "bottom":  dy = target.b - b.b; break;
                }
                if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) continue;

                // Convert the comp-space shift into the layer's parent space.
                var L = layers[i];
                var expr = L.threeDLayer
                    ? "var w = add(toWorld(anchorPoint), [" + dx + "," + dy + ",0]); hasParent ? parent.fromWorld(w) : w;"
                    : "var c = add(toComp(anchorPoint), [" + dx + "," + dy + "]); var p = hasParent ? parent.fromComp(c) : c; [p[0], p[1], 0];";
                var newPos = evalOnLayer(L, expr, t);
                offsetPosition(L, subV(newPos, currentPosition(L, t)));
            }
        });
    }

    // ---------------------------------------------------------------- anchor

    function moveAnchor(fx, fy) {
        var comp = activeComp(); if (!comp) return;
        var layers = selectedAVLayers(comp);
        if (!layers.length) return;

        undoable("Anchor Point", function () {
            var t = comp.time;
            for (var i = 0; i < layers.length; i++) {
                var L = layers[i];
                var r = L.sourceRectAtTime(t, false);
                if (r.width === 0 && r.height === 0) continue;

                var ap = L.property("ADBE Transform Group").property("ADBE Anchor Point");
                var cur = ap.valueAtTime(t, false);
                var z = cur.length > 2 ? cur[2] : 0;
                var nx = r.left + r.width * fx, ny = r.top + r.height * fy;

                // Where the new anchor currently sits, in parent space = the new position.
                var expr = L.threeDLayer
                    ? "var w = toWorld([" + nx + "," + ny + "," + z + "]); hasParent ? parent.fromWorld(w) : w;"
                    : "var c = toComp([" + nx + "," + ny + "]); var p = hasParent ? parent.fromComp(c) : c; [p[0], p[1], 0];";
                var newPos = evalOnLayer(L, expr, t);

                offsetPosition(L, subV(newPos, currentPosition(L, t)));
                ap = L.property("ADBE Transform Group").property("ADBE Anchor Point");
                offsetProp(ap, [nx - cur[0], ny - cur[1], 0]);
            }
        });
    }

    // ---------------------------------------------------------------- stagger

    // Selected, unlocked layers in stack order, bottom first (or top first
    // when reversed). The first layer in the list is the one that stays put.
    function staggerLayers(comp, reverse) {
        var sel = comp.selectedLayers, out = [], locked = 0;
        for (var i = 0; i < sel.length; i++) {
            if (sel[i].locked) locked++;
            else out.push(sel[i]);
        }
        out.sort(function (a, b) { return reverse ? a.index - b.index : b.index - a.index; });
        if (out.length < 2) {
            alert(locked ? "Some selected layers are locked. Unlock them first." : "Select two or more layers.", NAME);
            return null;
        }
        return out;
    }

    // Push each layer by one more step than the one before it, relative to
    // where it is now. Negative frames push backwards in time.
    function staggerOffset(frames, reverse) {
        var comp = activeComp(); if (!comp) return;
        var layers = staggerLayers(comp, reverse); if (!layers) return;
        var step = frames * comp.frameDuration;
        undoable("Stagger", function () {
            for (var i = 1; i < layers.length; i++) layers[i].startTime += step * i;
        });
    }

    // Line every layer's in-point up with the layer that stays put.
    function staggerLineUp(reverse) {
        var comp = activeComp(); if (!comp) return;
        var layers = staggerLayers(comp, reverse); if (!layers) return;
        undoable("Line Up", function () {
            var target = layers[0].inPoint;
            for (var i = 1; i < layers.length; i++) layers[i].startTime += target - layers[i].inPoint;
        });
    }

    // ---------------------------------------------------------------- UI

    function buildUI(thisObj) {
        var win = (thisObj instanceof Panel)
            ? thisObj
            : new Window("palette", NAME, undefined, { resizeable: true });
        win.orientation = "column";
        win.alignChildren = ["fill", "top"];
        win.spacing = 0;

        // ScriptUI stores the sizes it computes in each element's
        // preferredSize and reuses them on the next layout, so after an
        // orientation change everything keeps its old size. Clear them first.
        function resetSizes(el) {
            if (!el.__fixed) el.preferredSize = [-1, -1];
            if (el.children) for (var i = 0; i < el.children.length; i++) resetSizes(el.children[i]);
        }
        var colWidths = null;
        function relayout() {
            resetSizes(cols);
            if (colWidths) {
                // Assign whole sizes: setting only .width doesn't stick in ScriptUI.
                colA.preferredSize = [colWidths[0], -1];
                colB.preferredSize = [colWidths[1], -1];
            }
            win.layout.layout(true);
            win.layout.resize();
        }
        win.margins = 8;

        // Two columns of sections. They sit side by side when the panel is
        // wide enough, and stack when it is narrow (see reflow below).
        var cols = win.add("group");
        cols.orientation = "column";
        cols.alignChildren = ["fill", "top"];
        cols.spacing = 8;
        function column() {
            var c = cols.add("group");
            c.orientation = "column";
            c.alignChildren = ["fill", "top"];
            c.spacing = 6;
            return c;
        }
        var colA = column(), colB = column();

        // A collapsible section: header with a toggle, and a body that hides.
        // Collapsed state is remembered between sessions.
        function section(parent, title, key) {
            var p = parent.add("panel");
            p.alignChildren = ["fill", "top"];
            p.margins = [8, 6, 8, 8];
            p.spacing = 6;
            var head = p.add("group");
            head.alignChildren = ["left", "center"];
            head.spacing = 4;
            var tog = head.add("button", undefined, "\u25BE");
            tog.preferredSize = [22, 20]; tog.__fixed = true;
            tog.helpTip = "Show / hide";
            var label = head.add("statictext", undefined, title);
            try { label.graphics.font = ScriptUI.newFont(label.graphics.font.name, "BOLD", label.graphics.font.size); } catch (e) {}
            var body = p.add("group");
            body.orientation = "column";
            body.alignChildren = ["fill", "top"];
            body.spacing = 6;

            var settingKey = "collapsed_" + key;
            function setCollapsed(c, relayout) {
                body.visible = !c;
                body.maximumSize = [10000, c ? 0 : 10000];
                tog.text = c ? "\u25B8" : "\u25BE";
                try { app.settings.saveSetting(NAME, settingKey, c ? "1" : "0"); } catch (e) {}
                if (relayout) relayout();
            }
            tog.onClick = function () { setCollapsed(body.visible, true); };
            label.addEventListener("mousedown", function () { setCollapsed(body.visible, true); });
            var start = false;
            try { start = app.settings.haveSetting(NAME, settingKey) && app.settings.getSetting(NAME, settingKey) === "1"; } catch (e) {}
            p.__init = function () { if (start) setCollapsed(true, false); };
            sections.push(p);
            return body;
        }
        var sections = [];

        // --- Bounce
        var pB = section(colA, "Bounce / Excite", "bounce");
        pB.alignChildren = ["fill", "top"];
        var rowB = pB.add("group");
        rowB.alignChildren = ["left", "top"];
        function numField(parent, label, val, tip) {
            var g = parent.add("group");
            g.orientation = "column"; g.alignChildren = ["left", "top"]; g.spacing = 2;
            g.add("statictext", undefined, label);
            var e = g.add("edittext", undefined, String(val));
            e.characters = 5; e.helpTip = tip;
            return e;
        }
        var eAmp = numField(rowB, "Amplitude", 0.1, "How far it overshoots");
        var eFreq = numField(rowB, "Frequency", 2.0, "Wobbles per second");
        var eDecay = numField(rowB, "Decay", 2.0, "How quickly it settles");
        var cbLive = pB.add("checkbox", undefined, "Add sliders to layer (tweak later)");
        cbLive.value = true;
        cbLive.alignment = ["left", "top"];
        var rowBB = pB.add("group");
        var bApply = rowBB.add("button", undefined, "Apply Bounce");
        var bRemove = rowBB.add("button", undefined, "Remove");
        bApply.helpTip = "Select keyframed properties, then click";
        bRemove.helpTip = "Removes bounce from selected properties, or from whole selected layers if no property is selected";
        bApply.onClick = function () {
            applyBounce(readNum(eAmp, 0.1), readNum(eFreq, 2), readNum(eDecay, 2), cbLive.value);
        };
        bRemove.onClick = removeBounce;

        // --- Ease
        var pE = section(colA, "Easing", "ease");
        pE.alignChildren = ["fill", "top"];
        function easeRow(label, val) {
            var g = pE.add("group");
            g.alignChildren = ["fill", "center"];
            var s = g.add("statictext", undefined, label); s.preferredSize = [34, -1]; s.__fixed = true;
            var sl = g.add("slider", undefined, val, 0.1, 100); sl.alignment = ["fill", "center"];
            var e = g.add("edittext", undefined, String(val)); e.characters = 4;
            sl.onChanging = function () { e.text = String(Math.round(sl.value)); if (g.onSync) g.onSync(sl.value); };
            e.onChange = function () {
                var v = Math.max(0.1, Math.min(100, readNum(e, val)));
                sl.value = v; e.text = String(v); if (g.onSync) g.onSync(v);
            };
            return { group: g, slider: sl, text: e, set: function (v) { sl.value = v; e.text = String(Math.round(v)); } };
        }
        var rIn = easeRow("In", 33);
        var rOut = easeRow("Out", 33);
        var rBoth = easeRow("Both", 33);
        rBoth.group.onSync = function (v) { rIn.set(v); rOut.set(v); };
        rIn.slider.helpTip = "Ease in influence % (arriving at the keyframe)";
        rOut.slider.helpTip = "Ease out influence % (leaving the keyframe)";
        rBoth.slider.helpTip = "Moves In and Out together";
        var rowEB = pE.add("group");
        rowEB.alignment = ["fill", "top"];
        var bEase = rowEB.add("button", undefined, "Apply to Selected Keys");
        bEase.alignment = ["fill", "center"];
        bEase.onClick = function () { applyEase(rIn.slider.value, rOut.slider.value); };

        // --- Align
        var pA = section(colB, "Align", "align");
        pA.alignChildren = ["left", "top"];
        var rowAT = pA.add("group");
        rowAT.add("statictext", undefined, "Align to:");
        var ddTarget = rowAT.add("dropdownlist", undefined, ["Composition", "Selection"]);
        ddTarget.selection = 0;
        var alignWrap = pA.add("group");
        alignWrap.spacing = 4;
        alignWrap.alignChildren = ["left", "top"];
        var alignH = alignWrap.add("group"), alignV = alignWrap.add("group");
        alignH.spacing = alignV.spacing = 4;
        var aligns = [
            ["⇤", "left", "Align left edges"],
            ["↔", "hcenter", "Align horizontal centres"],
            ["⇥", "right", "Align right edges"],
            ["⤒", "top", "Align top edges"],
            ["↕", "vcenter", "Align vertical centres"],
            ["⤓", "bottom", "Align bottom edges"]
        ];
        for (var a = 0; a < aligns.length; a++) {
            (function (def, i) {
                var b = (i < 3 ? alignH : alignV).add("button", undefined, def[0]);
                b.preferredSize = [32, 26]; b.__fixed = true;
                b.helpTip = def[2];
                b.onClick = function () { alignLayers(def[1], ddTarget.selection.index === 1); };
            })(aligns[a], a);
        }

        // --- Anchor
        var pN = section(colB, "Anchor Point", "anchor");
        pN.alignChildren = ["left", "top"];
        var grid = pN.add("group");
        grid.orientation = "column"; grid.spacing = 3;
        var glyphs = [["↖", "↑", "↗"], ["←", "●", "→"], ["↙", "↓", "↘"]];
        var tips = [["Top left", "Top", "Top right"], ["Left", "Centre", "Right"], ["Bottom left", "Bottom", "Bottom right"]];
        for (var row = 0; row < 3; row++) {
            var gr = grid.add("group"); gr.spacing = 3;
            for (var col = 0; col < 3; col++) {
                (function (r, c) {
                    var b = gr.add("button", undefined, glyphs[r][c]);
                    b.preferredSize = [34, 26]; b.__fixed = true;
                    b.helpTip = "Anchor: " + tips[r][c];
                    b.onClick = function () { moveAnchor(c / 2, r / 2); };
                })(row, col);
            }
        }

        // --- Stagger
        var pS = section(colB, "Stagger", "stagger");
        pS.alignChildren = ["left", "top"];
        var rowS = pS.add("group");
        rowS.alignChildren = ["left", "center"];
        rowS.add("statictext", undefined, "Frames:");
        var eFrames = rowS.add("edittext", undefined, "5");
        eFrames.characters = 4;
        eFrames.helpTip = "Offset per layer, in frames";
        var cbReverse = rowS.add("checkbox", undefined, "Reverse");
        cbReverse.helpTip = "Keep the top layer in place and step downwards";
        var rowSB = pS.add("group");
        rowSB.spacing = 4;
        var rowBF = rowSB.add("group");
        rowBF.spacing = 4;
        var bBack = rowBF.add("button", undefined, "◀ Back");
        var bFwd = rowBF.add("button", undefined, "Forward ▶");
        var bLineUp = rowSB.add("button", undefined, "Line up");
        bBack.helpTip = "Push each layer earlier by one more step than the last";
        bFwd.helpTip = "Push each layer later by one more step than the last";
        bLineUp.helpTip = "Line every selected layer's start up with the one that stays put";
        function frames() { return Math.abs(readNum(eFrames, 5)); }
        bBack.onClick = function () { staggerOffset(-frames(), cbReverse.value); };
        bFwd.onClick = function () { staggerOffset(frames(), cbReverse.value); };
        bLineUp.onClick = function () { staggerLineUp(cbReverse.value); };

        // ------------------------------------------------ responsive layout

        // Right edge of a group's content (its children aren't stretched).
        function contentWidth(g) {
            var w = 0;
            for (var i = 0; i < g.children.length; i++) {
                var c = g.children[i];
                w = Math.max(w, c.location[0] + c.size[0]);
            }
            return w;
        }

        // Align: 0 = one row of six, 1 = two rows of three,
        // 2 = two columns of three (label above the dropdown).
        function setAlignMode(m) {
            rowAT.orientation = m === 2 ? "column" : "row";
            rowAT.alignChildren = m === 2 ? ["left", "top"] : ["left", "center"];
            alignWrap.orientation = m === 1 ? "column" : "row";
            alignH.orientation = alignV.orientation = m === 2 ? "column" : "row";
        }
        // Stagger: 0 = one row, 1 = Line up on its own row below.
        function setStaggerMode(m) {
            rowSB.orientation = m === 1 ? "column" : "row";
            rowSB.alignChildren = m === 1 ? ["fill", "top"] : ["left", "center"];
            // Explicit width, otherwise ScriptUI hands Line up the leftover space.
            bLineUp.__fixed = true;
            bLineUp.preferredSize = [m === 1 ? 2 * BTN_W + rowBF.spacing : BTN_W, -1];
        }

        // Measure every variant once, before any section is collapsed.
        // Columns are measured at their natural width (no stretching).
        var PANEL_PAD = 20;
        cols.alignChildren = ["left", "top"];
        relayout();
        var BTN_W = Math.max(bBack.size[0], bFwd.size[0]);
        bBack.preferredSize = bFwd.preferredSize = [BTN_W, -1];
        bBack.__fixed = bFwd.__fixed = true;
        var alignW = [], staggerW = [], m;
        for (m = 0; m < 3; m++) {
            setAlignMode(m); setStaggerMode(m === 0 ? 0 : 1);
            relayout();
            alignW[m] = contentWidth(pA);
            if (m < 2) staggerW[m] = contentWidth(pS);
        }
        // Left column: a little wider than it naturally needs.
        var capA = Math.round(colA.size[0] * 1.1);

        for (var si = 0; si < sections.length; si++) sections[si].__init();

        var state = "";
        function reflow() {
            var avail = win.size.width - 16;
            var rightNeed = Math.max(alignW[1], staggerW[1], contentWidth(pN)) + PANEL_PAD;
            var twoCol = avail >= capA + cols.spacing + rightNeed;
            var aW = twoCol ? capA : avail;
            var bW = twoCol ? avail - capA - cols.spacing : avail;
            var inner = bW - PANEL_PAD;
            // Bracketed on purpose: ExtendScript evaluates unbracketed chained
            // ternaries wrongly (a ? 0 : b ? 1 : 2 gives 2 when a is true).
            var am = (alignW[0] <= inner) ? 0 : ((alignW[1] <= inner) ? 1 : 2);
            var sm = staggerW[0] <= inner ? 0 : 1;

            var next = [twoCol, am, sm, aW, bW].join(",");
            if (next === state) return;
            state = next;
            cols.orientation = twoCol ? "row" : "column";
            cols.alignChildren = ["left", "top"];
            setAlignMode(am);
            setStaggerMode(sm);
            colWidths = [aW, bW];
            relayout();
        }
        win.onResizing = win.onResize = reflow;
        win.layout.layout(true);
        reflow();
        return win;
    }

    var ui = buildUI(thisObj);
    if (ui instanceof Window) { ui.center(); ui.show(); }
})(this);

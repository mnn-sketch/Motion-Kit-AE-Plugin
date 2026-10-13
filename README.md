# Motion Kit – AE Plugin

A dockable panel for Adobe After Effects with six small tools for everyday motion work. Every section can be collapsed, and the layout adapts to the panel's size: one column when it's narrow, two columns when it's wide.

## Features

### Bounce / Excite
Adds an inertial bounce to anything that's keyframed. Select one or more keyframed properties (Position, Scale, Rotation…), set **Amplitude** (how far it overshoots), **Frequency** (wobbles per second) and **Decay** (how quickly it settles), and click **Apply Bounce**.

With **Add sliders to layer** ticked, the three values become slider controls on the layer, so you can tweak or keyframe them later in Effect Controls. **Remove** takes the bounce off the selected properties, or off whole selected layers (sliders included) if no property is selected.

### Easing
Select keyframes, set the **In** and **Out** influence (0–100%), and click **Apply to Selected Keys**. **Both** moves In and Out together.

### Align
Select layers and align their left, centre, right, top, middle or bottom edges. **Align to** chooses between the composition and the selection. It uses each layer's visible edges, so scale, rotation and parenting are taken into account, and animated layers move with their whole animation.

### Anchor Point
Move the anchor point to any of nine positions (corners, edges or centre) without the layer moving on screen.

### Stagger
Offsets the selected layers in time like a staircase. The bottom layer stays put and each layer above moves one more step, e.g. 5, 10, 15 frames.

- **Forward ▶ / ◀ Back** push the layers later or earlier. Each click adds to the current timing, so Back undoes Forward.
- **Reverse** keeps the top layer in place instead.
- **Line up** moves every selected layer back to start at the same frame.

### Colours
Up to 5 palettes of up to 10 colours each. Click a swatch to set any colour property you've selected in the timeline. If you haven't selected one, it colours the selected layers: shape layer fills, text fill colour, or a solid's colour.

Use **+** for a new palette, **✎** to edit one (type hex codes separated by spaces, e.g. `#18181B #FFF 7635D1`) and **×** to delete. Palettes are saved between sessions.

## Install

No admin rights needed. You install it from inside After Effects:

1. Download `Motion Kit.jsx` from this repo.
2. In After Effects, go to **File → Scripts → Install ScriptUI Panel…** and choose `Motion Kit.jsx`.
3. Restart After Effects.

## Open the panel

Open the **Window** menu and scroll to the very bottom. Installed panels are listed there, below the built-in ones. Click **Motion Kit.jsx**.

It opens as a normal panel. Drag it by its tab to dock it anywhere in your workspace, and After Effects will remember where you put it.

## Update

To install a newer version, repeat the install steps with the new `Motion Kit.jsx`. Let it overwrite the old one, then restart After Effects.

## License

[MIT](LICENSE) © 2026 Mads Naumann

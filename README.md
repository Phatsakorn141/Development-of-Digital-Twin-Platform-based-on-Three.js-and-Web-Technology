# Digital Twin 3D Model Web App

A web-based 3D digital twin application using Three.js. 

## Features
- Load 3D models (.glb, .gltf)
- Interactive node tree viewer
- Create custom joints (rotation, translation) with multi-node support and custom pivot points
- Sensor simulation for joints
- State management: Save, load, and delete presets
- Keyframe animation: Record animation sequences and play back with interpolation
- Export and import project configurations (.dtwp)

## Usage
Run a local web server in this directory to view the app:
```bash
npx serve .
# or
python -m http.server 3000
```
Open `http://localhost:3000` in your browser.

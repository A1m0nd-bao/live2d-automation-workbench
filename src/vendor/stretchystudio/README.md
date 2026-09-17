# Pinned StretchyStudio engine

Source: https://github.com/MangoLion/stretchystudio
Commit: 24a83a27ba43e43e9d2e3de5e33994594e6199c2
License: MIT; see LICENSE. Only PSD/mesh/project/Cubism export modules are vendored.

Morph invokes a compatibility adapter, never the native-warp import path that
caused the confirmed missing-upper-body regression. PSD inputs build groups and
meshes, then use the standard Cubism rig generator. Existing .stretch inputs are
cloned before native warp nodes are omitted, retaining the original file.
This adapter is not a lossless conversion of hand-authored native warp lattices.

DWPose is loaded on demand in the browser and is used as a guarded joint
proposal: semantic PSD layer bounds remain the authority and the workflow
falls back to local estimation when the model is unavailable. The Wave Lab can
also accept a user-selected local ONNX file, which is read only for the current
browser session and is never uploaded.
No runtime .moc3 export is exposed or claimed as validated.

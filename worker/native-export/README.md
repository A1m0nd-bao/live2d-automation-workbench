# Local native export — demo rollout

Uses installed Cubism 5.3.03 libraries without GUI automation. The archive reader derives from autoLive2d (MIT, accompanying license). No PSD import or rebinding. Proprietary libraries are not distributed.

Compile ArchiveExportBridge.java with JDK 21: `javac -proc:none -cp '/Applications/Live2D Cubism 5.3/res/*' -d classes ArchiveExportBridge.java`.

Server environment:
- MORPH_EXPORT_JAVA: absolute Java 21 executable path
- MORPH_EXPORT_CLASSES: absolute compiled classes directory
- MORPH_CUBISM_LIBS: installed Cubism res directory

Existing authenticated direct relay is required. Content-addressed CMO3 jobs, 200 MB input limit, one compiler at a time, 240-second timeout, 2 GB heap, persisted status and restart recovery. Identical input reuses its job. Failed compilation does not create a successful runtime download. CMO3 is retained.

Core consistency, nonempty textures, mesh/deformer/parameter counts and individual vertex sweeps are checked. Not a visual-equivalence certification. No motion/physics sidecars synthesized. One original-resolution image per atlas is conservative and GPU-memory-heavy; atlas optimization and web visual QA remain pending.

This Mac must stay awake with its relay running. A worker without the configured local libraries returns 503. Review library licensing before deployment to another host. Never publish native libraries or credentials to Pages.

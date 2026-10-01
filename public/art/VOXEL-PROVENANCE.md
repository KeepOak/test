# Branch voxel options

The squirrel, owl and hedgehog models extrude the original sprite rows and palettes in `public/app/core/pets.js`. The oak consists of original boxes authored in `public/app/core/voxel-models.js`. Both are Branch source assets under the repository MIT license.

The renderer uses browser WebGL with original GLSL and depth-tested triangles. Its API reference is [MDN's WebGL introduction](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/Tutorial/Getting_started_with_WebGL); no tutorial source was copied. Each selected model is drawn once, copied to a local PNG image and releases its GPU context. Unsupported WebGL keeps the existing pixel pet or procedural oak fallback.

Classic Trunk 3D art continues to use the repository's existing Blender-rendered pebble sheets. Character videos and painted pet loops keep their existing assets and provenance. No Blender/Higgsfield generation, downloads, remote model resources or third-party model assets are introduced. Arbitrary GLB loading is not implemented.

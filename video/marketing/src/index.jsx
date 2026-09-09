import React from "react";
import { Composition, registerRoot } from "remotion";
import { Video } from "./Video.jsx";
import { FPS, DURATION, FORMATS } from "./story.mjs";
const Root = () => (
  <>
    {Object.entries(FORMATS).map(([format, dimensions]) => (
      <Composition
        key={format}
        {...dimensions}
        component={Video}
        fps={FPS}
        durationInFrames={FPS * DURATION}
        defaultProps={{ format }}
      />
    ))}
  </>
);
registerRoot(Root);

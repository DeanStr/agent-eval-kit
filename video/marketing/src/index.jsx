import React from "react";
import { Composition, registerRoot } from "remotion";
import { Video } from "./Video.jsx";
import { FPS, CUTS, FORMATS, compositionId } from "./story.mjs";
const Root = () => (
  <>
    {Object.entries(CUTS).flatMap(([cut, definition]) =>
      Object.entries(FORMATS).map(([format, dimensions]) => (
        <Composition
          key={`${cut}-${format}`}
          id={compositionId(cut, format)}
          {...dimensions}
          component={Video}
          fps={FPS}
          durationInFrames={FPS * definition.duration}
          defaultProps={{ format, cut }}
        />
      )),
    )}
  </>
);
registerRoot(Root);

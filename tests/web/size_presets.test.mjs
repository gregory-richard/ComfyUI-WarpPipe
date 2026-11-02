import assert from "node:assert/strict";
import { test } from "node:test";

import { upgradeSizePreset } from "../../web/size_presets.js";

// The dropdown as warp_pipe.py builds it: ratio, width, height.
const TABLE = [
  ["9:16", 576, 1024],
  ["9:16", 720, 1280],
  ["9:16", 1088, 1920],
  ["9:16", 1152, 2048],
  ["2:3", 832, 1248],
  ["2:3", 1024, 1536],
  ["2:3", 1360, 2048],
  ["3:4", 768, 1024],
  ["3:4", 864, 1152],
  ["3:4", 1152, 1536],
  ["3:4", 1536, 2048],
  ["4:5", 816, 1024],
  ["4:5", 1232, 1536],
  ["4:5", 1632, 2048],
  ["1:1", 768, 768],
  ["1:1", 1024, 1024],
  ["1:1", 1536, 1536],
  ["1:1", 2048, 2048],
  ["5:4", 1024, 816],
  ["5:4", 1536, 1232],
  ["5:4", 2048, 1632],
  ["4:3", 1024, 768],
  ["4:3", 1152, 864],
  ["4:3", 1536, 1152],
  ["4:3", 2048, 1536],
  ["3:2", 1248, 832],
  ["3:2", 1536, 1024],
  ["3:2", 2048, 1360],
  ["16:9", 1024, 576],
  ["16:9", 1280, 720],
  ["16:9", 1920, 1088],
  ["16:9", 2048, 1152],
];
const label = (ratio, w, h) => `${ratio} · ${w}×${h} · ${((w * h) / 1e6).toFixed(1)} MP`;
const OPTIONS = [...TABLE.map((row) => label(...row)), "Custom"];

// Every label 4.1 offered, exactly as it saved them, and where each one lands.
const OLD = [
  ["Mobile/Stories (small)      |  9:16  |   576 ×  1024  |  0.59 MP", 576, 1024],
  ["Mobile/Stories (HD)         |  9:16  |   720 ×  1280  |  0.92 MP", 720, 1280],
  ["Mobile/Stories (Full HD)    |  9:16  |  1080 ×  1920  |  2.07 MP", 1088, 1920],
  ["Mobile/Stories (max)        |  9:16  |  1152 ×  2048  |  2.36 MP", 1152, 2048],
  ["Portrait (classic)          |  3:4   |   768 ×  1024  |  0.79 MP", 768, 1024],
  ["Portrait (high-res)         |  3:4   |  1152 ×  1536  |  1.77 MP", 1152, 1536],
  ["Portrait (max)              |  3:4   |  1536 ×  2048  |  3.15 MP", 1536, 2048],
  ["Photo portrait              |  2:3   |   832 ×  1248  |  1.04 MP", 832, 1248],
  ["Photo portrait (high-res)   |  2:3   |  1024 ×  1536  |  1.57 MP", 1024, 1536],
  ["Photo portrait (max)        |  2:3   |  1368 ×  2048  |  2.80 MP", 1360, 2048],
  ["Instagram portrait          |  4:5   |   816 ×  1024  |  0.84 MP", 816, 1024],
  ["Instagram portrait (hi-res) |  4:5   |  1224 ×  1536  |  1.88 MP", 1232, 1536],
  ["Instagram portrait (max)    |  4:5   |  1640 ×  2048  |  3.36 MP", 1632, 2048],
  ["Square (small)              |  1:1   |   768 ×   768  |  0.59 MP", 768, 768],
  ["Square (SDXL native)        |  1:1   |  1024 ×  1024  |  1.05 MP", 1024, 1024],
  ["Square (high-res)           |  1:1   |  1536 ×  1536  |  2.36 MP", 1536, 1536],
  ["Square (max)                |  1:1   |  2048 ×  2048  |  4.19 MP", 2048, 2048],
  ["Instagram landscape         |  5:4   |  1024 ×   816  |  0.84 MP", 1024, 816],
  ["Instagram landscape (hi-res)|  5:4   |  1536 ×  1224  |  1.88 MP", 1536, 1232],
  ["Instagram landscape (max)   |  5:4   |  2048 ×  1640  |  3.36 MP", 2048, 1632],
  ["Photo landscape             |  3:2   |  1248 ×   832  |  1.04 MP", 1248, 832],
  ["Photo landscape (high-res)  |  3:2   |  1536 ×  1024  |  1.57 MP", 1536, 1024],
  ["Photo landscape (max)       |  3:2   |  2048 ×  1368  |  2.80 MP", 2048, 1360],
  ["Landscape (classic)         |  4:3   |  1024 ×   768  |  0.79 MP", 1024, 768],
  ["Landscape (high-res)        |  4:3   |  1536 ×  1152  |  1.77 MP", 1536, 1152],
  ["Landscape (max)             |  4:3   |  2048 ×  1536  |  3.15 MP", 2048, 1536],
  ["Widescreen (small)          |  16:9  |  1024 ×   576  |  0.59 MP", 1024, 576],
  ["Widescreen (720p)           |  16:9  |  1280 ×   720  |  0.92 MP", 1280, 720],
  ["Widescreen (1080p)          |  16:9  |  1920 ×  1080  |  2.07 MP", 1920, 1088],
  ["Widescreen (max)            |  16:9  |  2048 ×  1152  |  2.36 MP", 2048, 1152],
];

test("every label 4.1 saved finds the same place the server gives it", () => {
  for (const [old, w, h] of OLD) {
    assert.equal(
      upgradeSizePreset(old, OPTIONS),
      OPTIONS.find((o) => o.includes(`${w}×${h}`))
    );
  }
});

test("a label the dropdown offers today is left alone", () => {
  for (const option of OPTIONS) assert.equal(upgradeSizePreset(option, OPTIONS), null);
});

test("nothing is invented for a size the list does not have", () => {
  assert.equal(upgradeSizePreset("Poster | 2:1 | 2048 × 1024 | 2.10 MP", OPTIONS), null);
  assert.equal(upgradeSizePreset("no size here", OPTIONS), null);
  assert.equal(upgradeSizePreset(undefined, OPTIONS), null);
});

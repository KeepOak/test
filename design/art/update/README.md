# Update screen art: Branch building with pebbles

Made with Higgsfield on the owner's account for the update screen (`public/app/shell/updating.js`), one scene for the
dark look and one for the light look. Total cost: 28 credits (two stills, two 5-second loops).

## Reference

`public/art/branch-work.webp` (Branch's own mascot, converted to PNG) was uploaded as the image reference, so the
character keeps its design: the round dark-green leafy body, copper vine branches, glowing orange orb buds, green eyes.

## Stills (GPT Image 2.5, quality high, 16:9, the reference above)

`building-dark.png` (job 0cdd461d-7623-4357-b711-bd1b30ac90cd):

> The exact creature from the reference image (same design: round dark-green leafy body with swirling leaf folds,
> copper-orange vine branches tipped with small leaves and glowing orange orb buds, big friendly green eyes, leaf feet)
> stands in a small mossy clearing, happily placing one smooth glowing pebble on top of a little cairn of round river
> pebbles, as if building something new; a tiny fresh sprout with a glowing bud is growing from the top of the cairn.
> Night forest in deep teal-blue mist, a few warm orange fireflies drifting. Soft painterly 3D storybook render,
> cinematic lighting, gentle rim light. The creature and cairn are centered and fill the middle third; the edges fade
> into dark calm mist. No text, no frame.

`building-light.png` (job 7e932e53-efca-4293-b530-16a57b5209b3): the same, with "a little cairn of round pale river
pebbles", "a tiny fresh green sprout with a soft glowing bud", and the setting "Bright early-morning forest glade in
soft pale mint and cream mist, gentle sunbeams, airy and light, a few floating light motes … the edges fade into very
light, almost white-mint mist."

## Loops (MiniMax H3 Max, 5 s, 768p, 16:9; the still as both first and last frame, so it loops)

Dark (job 6ea8084b-16f9-4676-bc45-fe0d7efa1f2a):

> Seamless gentle loop, static locked-off camera. The little leafy creature gently bobs and breathes, lifts the glowing
> pebble, sets it softly on top of the pebble cairn, the tiny sprout on the cairn glows brighter for a moment, the
> creature blinks happily and returns to its starting pose holding a pebble. Its glowing orange orb buds pulse softly,
> fireflies drift slowly through the teal mist. Calm, cozy, slow motion, no camera movement, no cuts, the last frame
> matches the first frame.

Light (job 1acd253e-3790-4b13-8b6c-3e2788c2fef8): the same, with "the smooth pebble" and "light motes drift slowly
through the pale morning mist and sunbeams".

## What ships (public/art/update, 676 KB in all)

```sh
ffmpeg -i <loop>.mp4 -an -vf "scale=800:-2:flags=lanczos,fps=24" -c:v libvpx-vp9 -b:v 0 -crf 33 -row-mt 1 \
  -deadline good -cpu-used 1 -pix_fmt yuv420p building-<look>.webm      # 340 KB dark, 259 KB light
ffmpeg -i building-<look>.png -vf "scale=800:-2:flags=lanczos" -quality 82 building-<look>.webp  # the still
```

The still is what shows when motion is reduced (core/art17.js `media17`).

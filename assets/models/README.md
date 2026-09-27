# Avatar models

The `.glb` files here are downloaded by `npm run fetch:models` and are git-ignored.

| File | Source | License |
| --- | --- | --- |
| `mpfb.glb` (default) | Made with Blender + [MPFB/MakeHuman](https://static.makehumancommunity.org/mpfb.html), distributed by [TalkingHead](https://github.com/met4citizen/TalkingHead) | CC0 |
| `avaturn.glb` | [Avaturn](https://avaturn.me), via TalkingHead | Non-commercial use |
| `brunette.glb` | [Ready Player Me](https://readyplayer.me), via TalkingHead | CC BY-NC 4.0 |
| `avatarsdk.glb` | [AvatarSDK](https://avatarsdk.com), via TalkingHead | Non-commercial use |

## Using your own model

Upload any `.glb` or `.vrm` from the **Look** tab. The web app stores uploads in `~/.agentar/models/`.

For the best lip-sync, the model should have:

- **Mixamo-style bone names** (`Hips`, `Spine`, `Spine1`, `Spine2`, `Neck`, `Head`, `LeftArm`, …). With these, agentar applies a relaxed standing pose.
- **Oculus viseme morph targets** (`viseme_aa`, `viseme_PP`, `viseme_E`, …). If they are missing, agentar builds mouth shapes from ARKit blendshapes (`jawOpen`, `mouthFunnel`, …).
- **ARKit blendshapes** for blinking, gaze and moods (`eyeBlinkLeft`, `mouthSmileLeft`, `browInnerUp`, …).

VRM models (VRoid Studio etc.) work through their built-in `aa/ih/ou/ee/oh`, `blink` and emotion expressions.

The TalkingHead project documents how to export compatible avatars from MPFB, VRoid, Character Creator and Microsoft Rocketbox.

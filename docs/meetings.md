# Using agentar in video calls

Until agentar has a native meeting bot (see the roadmap), use OBS to turn the avatar into a camera.

## Video

1. Install [OBS Studio](https://obsproject.com).
2. Add a **Browser** source. Set the URL to `http://localhost:7777/?stage=1`, the size to 1280×720, and turn on "Control audio via OBS".
3. Click **Start Virtual Camera**.
4. In Zoom, Teams, or Meet, choose **OBS Virtual Camera** as your camera.

`?stage=1` hides the panel and orbit controls. Add `&captions=1` to show subtitles.

## Audio

The browser source plays the agent's voice inside OBS. To send that voice into the meeting as a microphone:

- **macOS**: install [BlackHole](https://existential.audio/blackhole/). In OBS, set Settings → Audio → Monitoring Device to BlackHole. Set the browser source to "Monitor and Output". Then choose BlackHole as the microphone in the meeting app.
- **Windows**: use [VB-Cable](https://vb-audio.com/Cable/) the same way.

If your main agentar tab is also open, it plays audio too. Open it with `?mute=1` to keep that view silent.

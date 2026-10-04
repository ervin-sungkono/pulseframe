# Pulseframe roadmap

- Automatic subtitle generation: later, send the selected audio to a service backed by a user or app supplied LLM API key. Convert its response into the existing `SubtitleCue[]` shape (`id`, `start`, `end`, `text`) so people can inspect and edit every block before export. Keep this separate from the manual subtitle editor; no API integration or key is included yet.

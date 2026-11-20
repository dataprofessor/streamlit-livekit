"""Example: talk to a LiveKit voice agent from Streamlit.

Streamlit's Python runs on the server, so it can't capture the user's microphone.
The `voice_agent` component splits the work:

- Python creates a LiveKit access token that also dispatches the agent.
- The component uses livekit-client in the browser to stream the mic to LiveKit
  and play the agent's voice. Streamlit never touches the audio.

Run your agent, then the app (from this folder, so it finds .streamlit/):

    lk agent dev --deployment local-dev
    streamlit run streamlit_app.py

`lk agent dev` registers the agent under a random dev deployment unless you name
one, so start it with `--deployment` set to AGENT_DEPLOYMENT below.

Credentials come from LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET, set
as environment variables or in .streamlit/secrets.toml.
"""

import streamlit as st

from streamlit_livekit import voice_agent

# The agent_name your agent registers with, e.g. @server.rtc_session(agent_name=...)
AGENT_NAME = "my-agent"

# Which deployment of the agent to dispatch. "local-dev" matches
# `lk agent dev --deployment local-dev`. Use "" for the production deployment
# on LiveKit Cloud.
AGENT_DEPLOYMENT = "local-dev"

st.set_page_config(page_title="Voice agent", page_icon="🎙️")
st.title("🎙️ Voice agent")
st.caption(
    "Audio streams directly between your browser and LiveKit. "
    "Streamlit only issues the token."
)

result = voice_agent(AGENT_NAME, deployment=AGENT_DEPLOYMENT)

# The transcript already lives in Python, so exporting it is a native download.
# on_click="ignore" skips the rerun; the call would survive one anyway.
st.download_button(
    "Export transcript",
    data=result.to_text(),
    file_name=f"{result.room}.txt",
    mime="text/plain",
    icon=":material/download:",
    disabled=not result.transcript,
    on_click="ignore",
)

st.caption(
    f"Room: `{result.room}` · Deployment: `{AGENT_DEPLOYMENT or 'production'}` · "
    f"State: `{result.state}` · Lines: {len(result.transcript)}"
)

# streamlit-livekit

`streamlit-livekit` is a Python library that adds real-time voice conversations with a [LiveKit](https://livekit.io/) agent to your [Streamlit](https://streamlit.io/) app.

Here it is in action: the user enters their name, starts a conversation, and asks the agent a question.

<img src="https://raw.githubusercontent.com/dataprofessor/streamlit-livekit/main/docs/demo.gif" width="550">

## How it works

The library gives you one function, `voice_agent()`, built with [Streamlit custom components (v2)](https://docs.streamlit.io/develop/api-reference/custom-components/st.components.v2.component). Call it, and your app shows a panel with:

- Start, End, and Mute buttons.
- Audio meters for you and the agent, plus the agent's state (listening, thinking, or speaking).
- A live transcript.

The panel matches your app's light, dark, or custom theme.

Behind the scenes, Python only creates an access token, which sends your agent to a fresh room for each conversation. The audio itself streams directly between the browser and LiveKit through [`livekit-client`](https://github.com/livekit/client-sdk-js).

## Installation

```console
pip install streamlit-livekit
```

You'll need Python 3.10+ and Streamlit 1.51+, plus a [LiveKit Cloud](https://cloud.livekit.io/) project (or a self-hosted LiveKit server) and an agent built with [LiveKit Agents](https://docs.livekit.io/agents/).

## Usage

```python
import streamlit as st
from streamlit_livekit import voice_agent

# "my-agent" is the name your agent registers under on LiveKit. You choose it
# in the agent's code, e.g. @server.rtc_session(agent_name="my-agent").
# LiveKit sends the agent with that name into each new conversation, so the
# two must match. Otherwise no agent joins and the panel keeps waiting.
result = voice_agent("my-agent")

st.write(result.state)  # "idle" | "connecting" | "connected" | "ended"
st.write(result.transcript)  # [{"role": "user" | "agent", "text": "..."}]

# Let the user save the conversation
st.download_button("Export transcript", result.to_text(), file_name="transcript.txt")
```

`voice_agent()` reads your LiveKit credentials from the `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` environment variables. You can also pass them as the `url`, `api_key`, and `api_secret` arguments.

### Talking to an agent on your machine

By default, `lk agent dev` registers your agent under a random `dev-...` deployment. Give the deployment a name instead, and pass the same name to `voice_agent()`:

```console
lk agent dev --deployment local-dev
```

```python
voice_agent("my-agent", deployment="local-dev")
```

To reach your production deployment on LiveKit Cloud, leave `deployment` empty.

### Passing context to your agent

Use `metadata` to send the agent anything it should know, such as the user's name, a persona picked in the sidebar, or the app's settings:

```python
name = st.text_input("Your name")
persona = st.selectbox("Persona", ["Friendly", "Concise", "Pirate"])

voice_agent("my-agent", metadata={"user_name": name, "persona": persona})
```

When a conversation starts, the dict reaches the agent as JSON job metadata. Read it in the agent's entrypoint:

```python
import json


@server.rtc_session(agent_name="my-agent")
async def my_agent(ctx: JobContext):
    context = json.loads(ctx.job.metadata or "{}")
    user_name = context.get("user_name")
    ...
```

LiveKit dispatches the agent when a conversation's room is created, so the metadata is fixed at that moment. If you change it while the panel is idle, the panel picks up the new value right away. If you change it during or after a conversation, the current call is left alone and the new value applies to the next one.

[LiveKit simulations](https://docs.livekit.io/testing/simulations/) can't set job metadata. To keep your agent testable, put the same values in each scenario's `userdata`, and have the agent read them from `ctx.simulation_context()` during a simulation.

## API

`voice_agent(agent_name, *, deployment="", metadata=None, url=None, api_key=None, api_secret=None, room_prefix="streamlit", token_ttl=timedelta(minutes=15), key="voice_agent")`

It returns a `VoiceAgentResult`:

| Field / method | Description |
|---|---|
| `state` | `"idle"`, `"connecting"`, `"connected"`, or `"ended"` |
| `transcript` | Final lines so far, as `[{"role": "user" \| "agent", "text": ...}]` |
| `room` | The LiveKit room for the current conversation |
| `to_text()` | The transcript as plain text, one `You:` or `Agent:` line per turn |

LiveKit only dispatches an agent when a room is created, so every conversation gets its own room. When the user clicks "New conversation", the panel asks Python for a fresh room and token.

## Example app

[`example/streamlit_app.py`](example/streamlit_app.py) is a complete page, including a name field and transcript export. To run it:

1. Copy `example/.streamlit/secrets.toml.example` to `example/.streamlit/secrets.toml` and fill in your LiveKit credentials.
2. Start your agent.
3. Run the app:

```console
cd example
streamlit run streamlit_app.py
```

## Development

```console
git clone https://github.com/dataprofessor/streamlit-livekit
cd streamlit-livekit
uv sync
uv run streamlit run example/streamlit_app.py
```

The code lives in [`streamlit_livekit/`](streamlit_livekit/). The Python API is in `__init__.py`, and the browser side (HTML, CSS, and JS) is in `frontend/`. Streamlit serves the CSS and JS from the `asset_dir` declared in `streamlit_livekit/pyproject.toml`. Edits to the JS and CSS show up when you reload the page, but Python changes need a restart of `streamlit run`.

Run the tests with `uv run pytest`, and format and lint with `uv run ruff format` and `uv run ruff check`.

## Notes

- The browser loads `livekit-client` from jsDelivr the first time you start a conversation.
- Microphone access needs a secure context: `localhost` or HTTPS.
- `result.transcript` only receives finished lines, so Streamlit doesn't rerun on every partial word. The panel itself still shows words as they arrive.

## License

MIT

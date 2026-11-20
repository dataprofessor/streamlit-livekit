"""Streamlit components for LiveKit.

``voice_agent()`` renders a panel that lets the user talk to a LiveKit agent in
real time. Audio streams directly between the browser and LiveKit; Python only
creates the access token that dispatches the agent to a fresh room.
"""

from __future__ import annotations

import functools
import os
import uuid
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Any, Literal

import streamlit as st
from livekit import api

__all__ = ["VoiceAgentResult", "voice_agent"]

ConnectionState = Literal["idle", "connecting", "connected", "ended"]

_FRONTEND = Path(__file__).parent / "frontend"


@functools.cache
def _component() -> Any:
    # Registered on first use: Streamlit only reads the asset_dir manifest when
    # its server starts, so registering at import time fails outside
    # `streamlit run` (in tests, for example)
    return st.components.v2.component(
        "streamlit-livekit.voice_agent",
        # Streamlit resolves css and js paths against asset_dir, but takes html as
        # markup, so read the file here
        html=(_FRONTEND / "voice_agent.html").read_text(encoding="utf-8"),
        css="voice_agent.css",
        js="voice_agent.js",
    )


@dataclass(frozen=True)
class VoiceAgentResult:
    """What the voice agent panel reports back to Python."""

    state: ConnectionState
    """``"idle"``, ``"connecting"``, ``"connected"`` or ``"ended"``."""
    transcript: list[dict[str, str]] = field(default_factory=list)
    """Final transcript lines so far, as ``{"role": "user" | "agent", "text": ...}``."""
    room: str = ""
    """Name of the LiveKit room for the current conversation."""

    def to_text(self) -> str:
        """The transcript as plain text, one ``You:`` or ``Agent:`` line per turn."""
        speakers = {"user": "You", "agent": "Agent"}
        return "".join(
            f"{speakers.get(line['role'], line['role'])}: {line['text']}\n"
            for line in self.transcript
        )


def _create_connection(
    *,
    agent_name: str,
    deployment: str,
    url: str,
    api_key: str,
    api_secret: str,
    room_prefix: str,
    token_ttl: timedelta,
) -> dict[str, str]:
    # Agent dispatch only applies when a room is created, so every
    # conversation gets its own room
    room = f"{room_prefix}-{uuid.uuid4().hex[:12]}"
    identity = f"user-{uuid.uuid4().hex[:8]}"
    token = (
        api.AccessToken(api_key, api_secret)
        .with_identity(identity)
        .with_ttl(token_ttl)
        .with_grants(api.VideoGrants(room_join=True, room=room))
        .with_room_config(
            api.RoomConfiguration(
                agents=[
                    api.RoomAgentDispatch(agent_name=agent_name, deployment=deployment)
                ]
            )
        )
        .to_jwt()
    )
    return {
        "url": url,
        "token": token,
        "identity": identity,
        "room": room,
        "agent_name": agent_name,
        "deployment": deployment,
    }


def voice_agent(
    agent_name: str,
    *,
    deployment: str = "",
    url: str | None = None,
    api_key: str | None = None,
    api_secret: str | None = None,
    room_prefix: str = "streamlit",
    token_ttl: timedelta = timedelta(minutes=15),
    key: str = "voice_agent",
) -> VoiceAgentResult:
    """Render a panel for talking to a LiveKit agent.

    Parameters
    ----------
    agent_name:
        The ``agent_name`` the agent registers with (``AgentServer`` /
        ``@server.rtc_session(agent_name=...)``). It is dispatched to each new room.
    deployment:
        The deployment to dispatch to. ``""`` is the production deployment on
        LiveKit Cloud; use the name passed to ``lk agent dev --deployment``
        to reach an agent running on your machine.
    url, api_key, api_secret:
        LiveKit project credentials. Default to the ``LIVEKIT_URL``,
        ``LIVEKIT_API_KEY`` and ``LIVEKIT_API_SECRET`` environment variables.
    room_prefix:
        Prefix for the room names, which get a random suffix per conversation.
    token_ttl:
        How long the user has to join after the token is created.
    key:
        Streamlit widget key. Use different keys for several panels on one page.
    """
    url = url or os.environ.get("LIVEKIT_URL", "")
    api_key = api_key or os.environ.get("LIVEKIT_API_KEY", "")
    api_secret = api_secret or os.environ.get("LIVEKIT_API_SECRET", "")
    missing = [
        name
        for name, value in [
            ("LIVEKIT_URL", url),
            ("LIVEKIT_API_KEY", api_key),
            ("LIVEKIT_API_SECRET", api_secret),
        ]
        if not value
    ]
    if missing:
        raise ValueError(
            f"voice_agent() needs LiveKit credentials. Set {', '.join(missing)} "
            "or pass url, api_key and api_secret."
        )

    conn_key = f"{key}__connection"

    def new_connection() -> None:
        st.session_state[conn_key] = _create_connection(
            agent_name=agent_name,
            deployment=deployment,
            url=url,
            api_key=api_key,
            api_secret=api_secret,
            room_prefix=room_prefix,
            token_ttl=token_ttl,
        )

    conn = st.session_state.get(conn_key)
    if (
        conn is None
        or conn["agent_name"] != agent_name
        or conn["deployment"] != deployment
        or conn["url"] != url
    ):
        new_connection()

    conn = st.session_state[conn_key]
    result = _component()(
        key=key,
        data={k: conn[k] for k in ("url", "token", "identity", "room")},
        default={"connection_state": "idle", "transcript": []},
        on_connection_state_change=lambda: None,
        on_transcript_change=lambda: None,
        # Runs before the rerun, so the panel gets the new token right away
        on_new_conversation_change=new_connection,
    )
    return VoiceAgentResult(
        state=getattr(result, "connection_state", None) or "idle",
        transcript=list(getattr(result, "transcript", None) or []),
        room=conn["room"],
    )

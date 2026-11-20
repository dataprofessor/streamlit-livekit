import json
from datetime import timedelta

from livekit import api

from streamlit_livekit import VoiceAgentResult, _create_connection, _encode_metadata

KEY, SECRET = "devkey", "a-secret-that-is-long-enough-for-hs256"


def make_connection(metadata: str = "", deployment: str = "") -> dict[str, str]:
    return _create_connection(
        agent_name="my-agent",
        deployment=deployment,
        metadata=metadata,
        url="wss://example.livekit.cloud",
        api_key=KEY,
        api_secret=SECRET,
        room_prefix="test",
        token_ttl=timedelta(minutes=5),
    )


def dispatch_of(conn: dict[str, str]) -> api.RoomAgentDispatch:
    claims = api.TokenVerifier(KEY, SECRET).verify(conn["token"])
    assert claims.video.room == conn["room"]
    (dispatch,) = claims.room_config.agents
    return dispatch


def test_encode_metadata():
    assert _encode_metadata(None) == ""
    assert _encode_metadata("plain text") == "plain text"
    # Key order doesn't change the encoding, so equal dicts compare equal
    assert _encode_metadata({"b": 1, "a": "x"}) == _encode_metadata({"a": "x", "b": 1})
    assert json.loads(_encode_metadata({"user_name": "Ada"})) == {"user_name": "Ada"}


def test_token_dispatches_agent_with_metadata():
    conn = make_connection(metadata='{"user_name":"Ada"}', deployment="local-dev")
    dispatch = dispatch_of(conn)
    assert dispatch.agent_name == "my-agent"
    assert dispatch.deployment == "local-dev"
    assert json.loads(dispatch.metadata) == {"user_name": "Ada"}


def test_token_without_metadata():
    assert dispatch_of(make_connection()).metadata == ""


def test_each_connection_gets_its_own_room():
    assert make_connection()["room"] != make_connection()["room"]


def test_to_text():
    result = VoiceAgentResult(
        state="ended",
        transcript=[
            {"role": "agent", "text": "Hi, how can I help?"},
            {"role": "user", "text": "What's new?"},
        ],
    )
    assert result.to_text() == "Agent: Hi, how can I help?\nYou: What's new?\n"
    assert VoiceAgentResult(state="idle").to_text() == ""

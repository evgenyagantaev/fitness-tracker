import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ["FITNESS_NO_AUTOAPP"] = "1"

from app.main import create_app  # noqa: E402

TOKEN = "test-token-123"


@pytest.fixture
def client(tmp_path):
    app = create_app(db_path=str(tmp_path / "t.db"), token=TOKEN)
    with TestClient(app) as c:
        c.headers.update({"Authorization": f"Bearer {TOKEN}"})
        yield c


def rec(date, pull=(), push=(), km=0.0, run_done=False, ts=1000):
    return {
        "date": date,
        "sets": {
            "pullups": {"reps": 3, "done": [i in pull for i in range(5)]},
            "pushups": {"reps": 15, "done": [i in push for i in range(5)]},
        },
        "distance": {"run": {"done": run_done, "km": km}},
        "updated_at": ts,
    }

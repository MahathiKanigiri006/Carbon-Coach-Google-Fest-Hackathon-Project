import asyncio
import logging
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from pydantic import BaseModel, Field

PROJECT_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(PROJECT_ROOT / "carbon_coach" / ".env", override=False)

from carbon_coach.agent import (
    get_reduction_recommendations,
    get_summary,
    normalize_travel_mode,
    root_agent,
)

logger = logging.getLogger(__name__)
APP_NAME = "carbon_coach"
USER_ID = "carbon-coach-web"

session_service = InMemorySessionService()
runner = Runner(
    app_name=APP_NAME,
    agent=root_agent,
    session_service=session_service,
)
session_locks: dict[str, asyncio.Lock] = {}

app = FastAPI(title="Carbon Coach API", version="1.0.0")
app.mount(
    "/static",
    StaticFiles(directory=PROJECT_ROOT / "frontend"),
    name="static",
)


class TravelRequest(BaseModel):
    mode: str = "bus"
    km: float = Field(gt=0, allow_inf_nan=False)


class ElectricityRequest(BaseModel):
    kwh: float = Field(gt=0, allow_inf_nan=False)


class FoodRequest(BaseModel):
    diet_type: str
    days: int = Field(gt=0)


class WasteRequest(BaseModel):
    kg: float = Field(gt=0, allow_inf_nan=False)
    disposal_method: str


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


def _session_lock(session_id: str) -> asyncio.Lock:
    return session_locks.setdefault(session_id, asyncio.Lock())


def _validate_session_id(session_id: str) -> str:
    try:
        return str(UUID(session_id))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Session not found.") from exc


async def _get_session(session_id: str):
    session_id = _validate_session_id(session_id)
    session = await session_service.get_session(
        app_name=APP_NAME,
        user_id=USER_ID,
        session_id=session_id,
    )
    if session is None:
        raise HTTPException(
            status_code=404,
            detail="This session has expired. Start a new session to continue.",
        )
    return session


async def _invoke_agent(
    session_id: str,
    prompt: str,
    expected_tool: str | None = None,
) -> tuple[dict | None, str]:
    session_id = _validate_session_id(session_id)
    async with _session_lock(session_id):
        await _get_session(session_id)
        tool_result = None
        response_text = []
        message = types.Content(
            role="user",
            parts=[types.Part(text=prompt)],
        )
        async for event in runner.run_async(
            user_id=USER_ID,
            session_id=session_id,
            new_message=message,
        ):
            if not event.content:
                continue
            for part in event.content.parts or []:
                function_response = part.function_response
                if (
                    expected_tool
                    and function_response
                    and function_response.name == expected_tool
                ):
                    tool_result = function_response.response
                if event.author == root_agent.name and part.text:
                    response_text.append(part.text)

        if expected_tool and tool_result is None:
            raise HTTPException(
                status_code=502,
                detail=f"The agent did not return results from {expected_tool}.",
            )
        return tool_result, "\n".join(response_text).strip()


async def _read_activity_state(session_id: str) -> list[dict]:
    session = await _get_session(session_id)
    return list(session.state.get("activities", []))


async def _run_calculation(
    session_id: str,
    prompt: str,
    expected_tool: str,
) -> dict:
    try:
        result, _ = await _invoke_agent(session_id, prompt, expected_tool)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("ADK calculation failed for tool %s", expected_tool)
        raise HTTPException(
            status_code=502,
            detail="The Carbon Coach agent could not complete this calculation. Check the server's AI configuration and try again.",
        ) from exc

    if not isinstance(result, dict):
        raise HTTPException(
            status_code=502,
            detail=f"The agent returned an invalid result from {expected_tool}.",
        )
    if result.get("error"):
        raise HTTPException(status_code=422, detail=result["error"])
    return result


@app.get("/")
async def index():
    return FileResponse(PROJECT_ROOT / "frontend" / "index.html")


@app.post("/api/session")
async def create_session():
    session_id = str(uuid4())
    await session_service.create_session(
        app_name=APP_NAME,
        user_id=USER_ID,
        session_id=session_id,
        state={"activities": []},
    )
    return {"session_id": session_id}


@app.get("/api/session/{session_id}")
async def check_session(session_id: str):
    session = await _get_session(session_id)
    return {"session_id": session.id}


@app.post("/api/session/{session_id}/clear-chat")
async def clear_chat(session_id: str):
    session_id = _validate_session_id(session_id)
    async with _session_lock(session_id):
        session = await _get_session(session_id)
        new_session_id = str(uuid4())
        await session_service.create_session(
            app_name=APP_NAME,
            user_id=USER_ID,
            session_id=new_session_id,
            state={"activities": list(session.state.get("activities", []))},
        )
        await session_service.delete_session(
            app_name=APP_NAME,
            user_id=USER_ID,
            session_id=session_id,
        )
        session_locks.pop(session_id, None)
    return {"session_id": new_session_id}


@app.post("/api/activities/travel")
async def calculate_travel(
    request: TravelRequest,
    x_session_id: str = Header(),
):
    mode = normalize_travel_mode(request.mode)
    supported_modes = {
        "bus",
        "car",
        "motorcycle",
        "auto_rickshaw",
        "train",
        "metro",
    }
    if mode not in supported_modes:
        raise HTTPException(
            status_code=422,
            detail="Choose bus, car, motorcycle/scooter, auto-rickshaw, train, or metro.",
        )
    return await _run_calculation(
        x_session_id,
        f"Record travel emissions for {request.km} km by {mode}. "
        f"Call calculate_travel_emissions with mode='{mode}' and km={request.km}. "
        "Do not estimate or calculate emissions yourself.",
        "calculate_travel_emissions",
    )


@app.post("/api/activities/electricity")
async def calculate_electricity(
    request: ElectricityRequest,
    x_session_id: str = Header(),
):
    return await _run_calculation(
        x_session_id,
        f"Record electricity emissions for {request.kwh} kWh. "
        f"Call calculate_electricity_emissions with kwh={request.kwh}. "
        "Do not estimate or calculate emissions yourself.",
        "calculate_electricity_emissions",
    )


@app.post("/api/activities/food")
async def calculate_food(
    request: FoodRequest,
    x_session_id: str = Header(),
):
    diet_type = request.diet_type.lower().replace("-", "_").replace(" ", "_")
    if diet_type not in {"vegetarian", "non_vegetarian"}:
        raise HTTPException(
            status_code=422,
            detail="Choose vegetarian or non-vegetarian.",
        )
    return await _run_calculation(
        x_session_id,
        f"Record an approximate daily diet estimate for {request.days} days "
        f"using diet_type='{diet_type}'. Call calculate_food_emissions with "
        f"diet_type='{diet_type}' and days={request.days}. "
        "Do not estimate or calculate emissions yourself.",
        "calculate_food_emissions",
    )


@app.post("/api/activities/waste")
async def calculate_waste(
    request: WasteRequest,
    x_session_id: str = Header(),
):
    disposal_method = request.disposal_method.lower().strip()
    if disposal_method not in {"composting", "landfill"}:
        raise HTTPException(
            status_code=422,
            detail="Choose composting or landfill.",
        )
    return await _run_calculation(
        x_session_id,
        f"Record emissions for {request.kg} kg of organic waste disposed by "
        f"{disposal_method}. Call calculate_waste_emissions with "
        f"kg={request.kg} and disposal_method='{disposal_method}'. "
        "Do not estimate or calculate emissions yourself.",
        "calculate_waste_emissions",
    )


@app.get("/api/dashboard")
async def dashboard(x_session_id: str = Header()):
    activities = await _read_activity_state(x_session_id)
    # These read-only agent tools need only session state, so avoid an LLM round trip.
    tool_context = SimpleNamespace(state={"activities": activities})
    summary = get_summary("current session", tool_context)
    recommendation_result = get_reduction_recommendations(tool_context)

    category_by_activity = {
        activity["details"]: activity["category"] for activity in activities
    }
    recommendations = [
        {
            "category": category_by_activity.get(recommendation.get("activity"), "Activity"),
            **recommendation,
        }
        for recommendation in recommendation_result.get("recommendations", [])
    ]
    breakdown = summary.get("category_breakdown", {})
    return {
        "total_emissions_kg_co2e": summary.get("total_emissions_kg_co2e", 0),
        "activity_count": summary.get("activity_count", len(activities)),
        "category_breakdown": {
            category: breakdown.get(category, 0)
            for category in ("Travel", "Electricity", "Food", "Waste")
        },
        "activities": summary.get("activities", activities),
        "recommendations": recommendations,
        "reduction_potential_kg_co2e": round(
            sum(
                recommendation.get("estimated_savings_kg_co2e", 0)
                for recommendation in recommendations
            ),
            4,
        ),
        "recommendation_note": recommendation_result.get("note", ""),
        "empty": not activities,
    }


@app.get("/api/recommendations")
async def recommendations(x_session_id: str = Header()):
    dashboard_data = await dashboard(x_session_id)
    return {
        "recommendations": dashboard_data["recommendations"],
        "reduction_potential_kg_co2e": dashboard_data[
            "reduction_potential_kg_co2e"
        ],
        "note": dashboard_data.get("recommendation_note", ""),
        "empty": dashboard_data["empty"],
    }


@app.post("/api/chat")
async def chat(request: ChatRequest, x_session_id: str = Header()):
    try:
        _, response = await _invoke_agent(x_session_id, request.message)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("ADK chat request failed")
        raise HTTPException(
            status_code=502,
            detail="Carbon Coach AI could not respond. Check the server's AI configuration and try again.",
        ) from exc
    if not response:
        raise HTTPException(
            status_code=502,
            detail="Carbon Coach AI returned an empty response. Please try again.",
        )
    return {"response": response}

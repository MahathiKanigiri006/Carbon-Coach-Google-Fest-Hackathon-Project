
import re

from google.adk.agents import Agent
from google.adk.tools import ToolContext

ELECTRICITY_FACTOR = 0.710
BUS_FACTOR = 0.12525
TRAVEL_FACTORS = {
    "bus": (
        BUS_FACTOR,
        "kg CO2e per passenger-km",
        "UK Government GHG Conversion Factors 2025",
        "UK bus passenger-km proxy; not India-specific.",
        "bus",
    ),
    "car": (
        0.14943,
        "kg CO2 per vehicle-km",
        "India GHG Program, India Specific Road Transport Emission Factors",
        "Petrol hatchback example; whole-vehicle emissions, not divided among passengers. CO2-only factor.",
        "car",
    ),
    "motorcycle": (
        0.0368,
        "kg CO2 per vehicle-km",
        "India GHG Program, India Specific Road Transport Emission Factors",
        "Scooter under 110 cc proxy; whole-vehicle emissions, not divided among passengers. CO2-only factor.",
        "motorcycle/scooter (under 110 cc proxy)",
    ),
    "auto_rickshaw": (
        0.10768,
        "kg CO2 per vehicle-km",
        "India GHG Program, India Specific Road Transport Emission Factors",
        "CNG auto-rickshaw proxy; whole-vehicle emissions, not divided among passengers. CO2-only factor.",
        "CNG auto-rickshaw",
    ),
    "train": (
        0.00794,
        "kg CO2 per passenger-km",
        "India GHG Program, India Specific Rail Transport Emission Factors for Passenger Travel (2012-13)",
        "Historical Indian non-suburban rail estimate; passenger-km basis and CO2-only factor.",
        "train",
    ),
    "metro": (
        0.00794,
        "kg CO2 per passenger-km",
        "India GHG Program, India Specific Rail Transport Emission Factors for Passenger Travel (2012-13)",
        "Indian non-suburban rail factor used as a metro proxy; not a metro-specific factor. Passenger-km basis and CO2-only factor.",
        "metro (rail proxy)",
    ),
}


def normalize_travel_mode(mode: str) -> str:
    normalized_mode = re.sub(r"[^a-z0-9]+", "_", mode.lower()).strip("_")
    aliases = {
        "auto": "auto_rickshaw",
        "motorbike": "motorcycle",
        "motorcycle_scooter": "motorcycle",
        "rickshaw": "auto_rickshaw",
        "scooter": "motorcycle",
    }
    return aliases.get(normalized_mode, normalized_mode)


def save_activity(category, details, emissions, tool_context, note=None):
    """Save a successfully calculated activity in session memory."""

    activities = list(tool_context.state.get("activities", []))

    activity = {
        "category": category,
        "details": details,
        "emissions": emissions
    }
    if note:
        activity["note"] = note
    activities.append(activity)

    tool_context.state["activities"] = activities


def calculate_travel_emissions(
    mode: str,
    km: float,
    tool_context: ToolContext
) -> dict:
    """Calculate and save emissions for supported transport modes.

    Args:
        mode: bus, car, motorcycle/scooter, auto_rickshaw, train, or metro.
        km: Distance travelled in kilometres.
    """

    if km <= 0:
        return {"error": "Distance must be greater than zero."}

    normalized_mode = normalize_travel_mode(mode)
    factor_data = TRAVEL_FACTORS.get(normalized_mode)
    if factor_data is None:
        return {
            "error": "Choose bus, car, motorcycle, auto_rickshaw, train, or metro."
        }

    factor, factor_unit, source, note, activity_mode = factor_data
    emissions = round(km * factor, 4)

    save_activity(
        "Travel",
        f"{km} km by {activity_mode}",
        emissions,
        tool_context,
        note
    )

    return {
        "category": "Travel",
        "emissions_kg_co2e": emissions,
        "factor": factor,
        "factor_unit": factor_unit,
        "source": source,
        "note": note
    }


def calculate_electricity_emissions(
    kwh: float,
    tool_context: ToolContext
) -> dict:
    """Calculate and save emissions from electricity consumption.

    Args:
        kwh: Electricity consumed in kilowatt-hours.
    """

    if kwh <= 0:
        return {"error": "Electricity usage must be greater than zero."}

    emissions = round(kwh * ELECTRICITY_FACTOR, 4)

    save_activity(
        "Electricity",
        f"{kwh} kWh",
        emissions,
        tool_context
    )

    return {
        "category": "Electricity",
        "emissions_kg_co2e": emissions,
        "factor": ELECTRICITY_FACTOR,
        "source": "CEA India Grid Emission Factor, FY 2024-25"
    }
def calculate_waste_emissions(
    kg: float,
    disposal_method: str,
    tool_context: ToolContext
) -> dict:
    """Estimate emissions from organic waste disposal.

    Args:
        kg: Weight of organic waste in kilograms.
        disposal_method: composting or landfill.
    """

    if kg <= 0:
        return {"error": "Waste weight must be greater than zero."}

    factors = {
        "composting": 0.32,
        "landfill": 1.29
    }

    method = disposal_method.lower().strip()

    if method not in factors:
        return {
            "error": "Choose either composting or landfill."
        }

    factor = factors[method]
    emissions = round(kg * factor, 4)

    save_activity(
        "Waste",
        f"{kg} kg organic waste via {method}",
        emissions,
        tool_context
    )

    return {
        "category": "Waste",
        "waste_kg": kg,
        "disposal_method": method,
        "emissions_kg_co2e": emissions,
        "factor": factor,
        "source": "MoEFCC, Low Carbon Lifestyles document"
    }
def calculate_food_emissions(
    diet_type: str,
    days: int,
    tool_context: ToolContext
) -> dict:
    """Estimate food emissions using Indian daily diet estimates.

    Args:
        diet_type: vegetarian or non_vegetarian.
        days: Number of days.
    """

    if days <= 0:
        return {"error": "Days must be greater than zero."}

    factors = {
        "vegetarian": 0.7237,
        "non_vegetarian": 1.3027
    }

    diet = diet_type.lower().strip().replace("-", "_").replace(" ", "_")

    if diet not in factors:
        return {
            "error": "Choose vegetarian or non_vegetarian."
        }

    factor = factors[diet]
    emissions = round(factor * days, 4)

    save_activity(
        "Food",
        f"{diet} diet for {days} day(s)",
        emissions,
        tool_context
    )

    return {
        "category": "Food",
        "diet_type": diet,
        "days": days,
        "emissions_kg_co2e": emissions,
        "daily_factor": factor,
        "source": "Pathak et al. (2010), Carbon footprints of Indian food items",
        "note": "Approximate daily diet estimate, not a meal-specific measurement."
    }
def get_summary(period: str, tool_context: ToolContext) -> dict:
    """Retrieve recorded activities and calculate their total emissions.

    Args:
        period: Requested period, such as today or this week.
    """

    activities = tool_context.state.get("activities", [])

    if not activities:
        return {"message": "No activities recorded yet."}

    total = sum(item["emissions"] for item in activities)

    breakdown = {}

    for item in activities:
        category = item["category"]

        breakdown[category] = round(
            breakdown.get(category, 0) + item["emissions"],
            4
        )

    return {
        "scope": "Current session only; not date-filtered.",
        "total_emissions_kg_co2e": round(total, 4),
        "activity_count": len(activities),
        "category_breakdown": breakdown,
        "activities": activities
    }
def get_reduction_recommendations(tool_context: ToolContext) -> dict:
    """Generate personalized carbon-reduction suggestions from session activities."""

    activities = tool_context.state.get("activities", [])

    if not activities:
        return {
            "message": "No activities recorded yet. Track some activities first."
        }

    recommendations = []

    for item in activities:
        category = item["category"]
        details = item["details"].lower()
        emissions = item["emissions"]

        if category == "Electricity":
            saving = round(emissions * 0.10, 4)
            recommendations.append({
                "activity": item["details"],
                "suggestion": "Try reducing electricity consumption by 10% by switching off unused lights and appliances.",
                "estimated_savings_kg_co2e": saving,
                "assumption": "A hypothetical 10% reduction in recorded electricity use."
            })

        elif category == "Travel":
            saving = round(emissions * 0.10, 4)
            recommendations.append({
                "activity": item["details"],
                "suggestion": "Consider reducing unnecessary trips or combining journeys where practical.",
                "estimated_savings_kg_co2e": saving,
                "assumption": "A hypothetical 10% reduction in the recorded travel distance using the same mode and emission factor."
            })

        elif category == "Waste" and "landfill" in details:
            parts = details.split()
            try:
                kg = float(parts[0])
                saving = round(kg * (1.29 - 0.32), 4)
                recommendations.append({
                    "activity": item["details"],
                    "suggestion": "Consider composting organic waste instead of sending it to landfill.",
                    "estimated_savings_kg_co2e": saving,
                    "assumption": "Assumes the same waste quantity is composted instead of landfilled."
                })
            except (ValueError, IndexError):
                pass

        elif category == "Food" and "non_vegetarian" in details:
            parts = details.split()
            try:
                days = int(parts[-2])
                saving = round(days * (1.3027 - 0.7237), 4)
                recommendations.append({
                    "activity": item["details"],
                    "suggestion": "Consider trying vegetarian meals on some days.",
                    "estimated_savings_kg_co2e": saving,
                    "assumption": "Hypothetical switch from the estimated non-vegetarian daily diet to the vegetarian daily diet for the same number of days."
                })
            except (ValueError, IndexError):
                pass

    if not recommendations:
        return {
            "message": "No specific reduction recommendations are available for your recorded activities yet."
        }

    return {
        "recommendations": recommendations,
        "note": "Savings are scenario estimates, not guaranteed reductions. They depend on the stated assumptions."
    }


root_agent = Agent(
    model="gemini-3.5-flash-lite",
    name="carbon_coach",

    description="AI-powered carbon footprint tracking assistant.",

    instruction="""
    You are Carbon Coach, an intelligent environmental assistant.

    IMPORTANT RULES:

    1. Understand activities described in natural language.
    2. For bus travel, call calculate_travel_emissions.
    3. For electricity, call calculate_electricity_emissions.
    4. Never calculate emissions yourself.
    5. Never invent emission factors or numerical results.
    6. Every successful calculation is automatically saved.
    7. When asked for totals, call get_summary.
    8. Clearly explain results and emission factor sources.
    9. Never claim an activity was saved if its tool failed.
    10. For organic waste disposal, call calculate_waste_emissions.
    11. Ask whether the waste was composted or sent to landfill if the method is not specified.
    12. For food-related daily diet estimates, call calculate_food_emissions.
    13. Ask whether the diet is vegetarian or non-vegetarian if it is not specified.    
    14. Ask how many days to estimate if the duration is missing.
    15. Clearly explain that these are approximate daily estimates, not exact meal-level emissions.
    16. When users ask how to reduce their carbon footprint, call get_reduction_recommendations.    
    17. Explain recommendations in simple, actionable language.
    18. Clearly distinguish estimated savings from guaranteed savings.
    19. Never invent savings or emission factors.
    Supported activities:
    - Bus, car, motorcycle/scooter, auto-rickshaw, train, and metro travel
    - Electricity consumption
    - Organic waste disposal by composting or landfill
    - Approximate daily vegetarian or non-vegetarian diet estimates

    Memory is limited to the current ADK session.
    Do not claim that session totals are weekly or monthly totals.
    """,

    tools=[
        calculate_travel_emissions,
        calculate_electricity_emissions,
        calculate_waste_emissions,
        calculate_food_emissions,
        get_summary,
        get_reduction_recommendations
    ]
)

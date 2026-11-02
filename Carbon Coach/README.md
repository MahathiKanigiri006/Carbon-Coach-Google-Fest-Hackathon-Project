<<<<<<< HEAD
# Carbon Coach

Carbon Coach is a responsive carbon-footprint dashboard connected to the existing Google ADK agent in `carbon_coach/agent.py`. The frontend never calculates emissions or receives an API key: activity calculations, session summaries, recommendations, and chat are handled by the existing agent tools.

## Run locally

1. Use Python 3.10 or later and install the project dependencies:

   ```bash
   python -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

2. Set `GOOGLE_API_KEY` in the existing `carbon_coach/.env` file. The application reads this file without overriding environment variables. Do not commit the file.

   If `carbon_coach/.env` does not already exist, copy `.env.example` there and replace the placeholder with your key. Do not overwrite an existing credentials file.

3. Start the API and frontend from the project root:

   ```bash
   uvicorn backend.main:app --reload
   ```

4. Open [http://127.0.0.1:8000](http://127.0.0.1:8000).

## Session and calculation notes

- Each browser receives an ADK in-memory session. Its chat and recorded activities are shared with the dashboard and recommendations during that session.
- Chat history is kept in the browser for the current ADK session. Clearing chat starts a fresh ADK conversation while retaining that session's recorded activities.
- In-memory sessions reset when the server restarts. The API boundary is separated from storage so a persistent ADK session service can be introduced later.
- Travel modes are bus, car, motorcycle/scooter, auto-rickshaw, train, and metro. Road factors are whole-vehicle CO2 estimates and are not divided among passengers; the car, two-wheeler, and CNG auto-rickshaw values use representative India GHG Program road-factor examples. Train uses a historical Indian passenger-km estimate. Metro uses that rail factor only as an explicitly labeled proxy because the source does not provide a metro-specific factor. Bus retains the existing UK passenger-km proxy. These different factor bases and source years are shown in calculation results and should be considered when comparing travel modes.
- Transport factor references: [India GHG Program road transport factors](https://indiaghgp.org/sites/default/files/Road%20Transport%20Technical%20Paper.pdf) and [India GHG Program passenger rail factors](https://indiaghgp.org/sites/default/files/Rail%20Transport%20Emission.pdf). These are estimates with the mode-specific scopes shown in the UI, not a uniform lifecycle assessment.
- Food emissions are approximate daily diet estimates, not meal-specific measurements. The agent's emission-factor sources and assumptions are returned with calculations and recommendations.
- Recommendation savings are estimates based on the agent's stated assumptions, not guaranteed reductions.
=======
# CarbonCoach-Google-DevFest
Carbon Coach is an AI-powered carbon footprint tracking assistant built with Google ADK and Gemini. It helps users calculate, monitor, and understand their carbon emissions from travel, electricity, food, and waste while providing personalized recommendations to promote sustainable living.
>>>>>>> 8cf04c6bee7f728da5bf2c6550eefc90f796a409

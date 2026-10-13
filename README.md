# Auto Task Agent

Auto Task Agent is an AI-powered platform for automating tasks with
LLMs, tools, and workflow orchestration.

## Current Agent: CareerSync

CareerSync updates a portfolio based on an uploaded resume. It parses
the resume, analyzes the portfolio, updates relevant files, validates
the changes, and publishes the changes to the portfolio repository's
`develop` branch.

## How It Works

1.  Upload a resume PDF to the CareerSync API.
2.  The API parses the resume and prepares the workflow context.
3.  LangGraph runs the configured workflow nodes.
4.  The workflow analyzes the portfolio, reads relevant files, and
    applies updates.
5.  The changes are validated.
6.  The publishing service commits and pushes the approved changes to
    `develop`.

> The current implementation uses a configured workflow. LLM-driven tool
> selection and a more dynamic agent loop are planned for exploration.

## Tech Stack

-   Node.js
-   TypeScript
-   Express
-   LangChain
-   LangGraph
-   OpenAI API
-   Zod
-   Git and GitHub

## Main Components

  -----------------------------------------------------------------------
  Component                           Responsibility
  ----------------------------------- -----------------------------------
  `career-sync.routes.ts`             Receives the resume upload and
                                      starts the workflow.

  `career-sync-context.service.ts`    Prepares the context used by the
                                      workflow.

  `career-sync.state.ts`              Defines the shared workflow state.

  `career-sync.graph.ts`              Defines the workflow nodes and
                                      transitions.

  `career-sync.nodes.ts`              Implements the workflow steps.

  `github-publishing.service.ts`      Commits and pushes portfolio
                                      changes to GitHub.
  -----------------------------------------------------------------------

## Requirements

-   Node.js and npm
-   An OpenAI API key
-   A GitHub token with permission to push to the portfolio repository
-   A local portfolio repository configured for CareerSync

## Setup

1.  Clone this repository.

2.  Install dependencies:

    ``` bash
    npm install
    ```

3.  Create a `.env` file in the project root and configure the
    environment variables required by the application. Check the source
    code for the exact variable names. Example:

    ``` env
    OPENAI_API_KEY=your_openai_api_key
    GITHUB_TOKEN=your_github_token
    PORTFOLIO_REPO_URL=https://github.com/your-account/your-portfolio-repo.git
    PORT=3000
    ```

4.  Configure the portfolio repository path and other required settings
    to match your local environment.

5.  Start the application using the script defined in `package.json`,
    for example:

    ``` bash
    npm run dev
    ```

## API Usage

The examples below assume the API runs on `http://localhost:3000`.
Adjust the base URL and route to match your application configuration.

### Run CareerSync

The endpoint accepts a PDF resume as multipart form data.

``` bash
curl -X POST http://localhost:3000/api/career-sync/run \
  -F "resume=@/absolute/path/to/Prabhat.pdf"
```

Replace `/absolute/path/to/Prabhat.pdf` with the path to your PDF.

If your route uses a different mount path or upload field name, use the
exact path and field name defined in `career-sync.routes.ts`.

### Example success response

The exact response fields depend on the current route implementation. A
response may look like:

``` json
{
  "success": true,
  "message": "CareerSync completed",
  "data": {
    "stage": "completed",
    "updatedPaths": [
      "src/app/experience/page.tsx",
      "src/app/skills/page.tsx"
    ],
    "pullRequestUrl": ""
  }
}
```

This is an illustrative example; confirm the actual response structure
in `career-sync.routes.ts`.

### Example error response

``` json
{
  "success": false,
  "message": "CareerSync failed"
}
```

This is illustrative. The actual status code and response fields depend
on the route's error handling.

## Testing

Run the test command configured in `package.json`, for example:

``` bash
npm test
```

## Safety Notes

-   Keep API keys and tokens in environment variables; never commit
    secrets.
-   Review portfolio changes before publishing.
-   CareerSync is configured to publish directly to `develop`; keep
    `main` untouched.
-   Use a GitHub token with only the permissions required for the target
    repository.

## Project Goal

Auto Task Agent is intended to support multiple specialized agents over
time. CareerSync is the first agent, focused on keeping a portfolio
aligned with the latest resume.

# Sweet Creatures Employee Attendance Management System 

## Run the app locally

1. Create a development MySQL schema named `sweet_creatures` and apply `database/schema.sql` to an empty schema. The dump contains `DROP TABLE` statements; do not run it against a database with data you need to keep.
2. In `backend`, copy `.env.example` to `.env` and set your local MySQL credentials and a private JWT secret.
3. From the `backend` directory, install dependencies with `npm ci`.
4. The development schema includes the administrator account `lysa` with PIN `12345`. If you maintain an existing database instead of applying the schema, create it once with `node src/scripts/createAdmin.js lysa lysa@example.com 12345`.
5. Start the app with `npm start` and open `http://localhost:5000`.

The login and Staff page use the backend. Attendance, payroll, cash advances, policies, and SOP are still prototype-only and use browser data.

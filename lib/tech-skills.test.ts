import { describe, it, expect } from "vitest";
import { extractTechSkills } from "./tech-skills";

describe("extractTechSkills", () => {
  it("pulls real technologies out of interview text, in order, de-duplicated", () => {
    const text =
      "I built the frontend in React and Next.js, the API in Python with FastAPI, " +
      "stored data in Postgres and Redis, deployed on AWS with Docker and Kubernetes. React again.";
    const names = extractTechSkills(text).map((s) => s.name);
    expect(names).toEqual([
      "React",
      "Next.js",
      "Python",
      "FastAPI",
      "PostgreSQL",
      "Redis",
      "AWS",
      "Docker",
      "Kubernetes",
    ]);
  });

  it("does not match 'java' inside 'javascript'", () => {
    const names = extractTechSkills("We use JavaScript everywhere.").map((s) => s.name);
    expect(names).toContain("JavaScript");
    expect(names).not.toContain("Java");
  });

  it("handles c++, c# and .net token boundaries", () => {
    const names = extractTechSkills("Backend in C# on .NET; some C++ for the engine.").map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["C#", ".NET", "C++"]));
  });

  it("returns [] when no tech is mentioned", () => {
    expect(extractTechSkills("I led the team and communicated clearly.")).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  describeHtmlBody,
  htmlLinks,
  MAX_LINKS,
  MAX_PREVIEW_CHARS,
} from "../../src/domains/mail/html.js";

/**
 * The module is a pure function on a string, so every case here is the string
 * and its rendering. What it guards is narrow and specific: the degradation
 * erases a link's target, and this is where the target comes back.
 */

describe("htmlLinks", () => {
  it("reads a target through each of the three quoting forms", () => {
    const html =
      '<a href="https://example.org/double">a</a>' +
      "<a href='https://example.org/single'>b</a>" +
      "<a href=https://example.org/bare>c</a>";

    expect(htmlLinks(html)).toEqual([
      "https://example.org/double",
      "https://example.org/single",
      "https://example.org/bare",
    ]);
  });

  it("lists a repeated target once, in the order it first appeared", () => {
    const html =
      '<a href="https://b.example/second">b</a>' +
      '<a href="https://a.example/first">a</a>' +
      '<a href="https://b.example/second">b again</a>';

    expect(htmlLinks(html)).toEqual(["https://b.example/second", "https://a.example/first"]);
  });

  it("leaves an image source out: an embedded image is out of scope of sending", () => {
    const html = '<img src="https://tracker.example/pixel.gif"><a href="https://ok.example">x</a>';

    expect(htmlLinks(html)).toEqual(["https://ok.example"]);
  });

  it("reads a target through whitespace around the equals sign", () => {
    expect(htmlLinks('<a href = "https://spaced.example">x</a>')).toEqual([
      "https://spaced.example",
    ]);
  });

  it("returns nothing on a body that carries no link", () => {
    expect(htmlLinks("<p>Bonjour <strong>Camille</strong></p>")).toEqual([]);
  });
});

describe("describeHtmlBody", () => {
  it("shows the markup degraded to the text a reader would see", () => {
    const described = describeHtmlBody("<p>Bonjour <strong>Camille</strong> &amp; Ana</p>");

    expect(described).toContain("Bonjour Camille & Ana");
    expect(described).not.toContain("<strong>");
  });

  it("lists the targets the degradation just erased", () => {
    const html = '<p>Voir <a href="https://example.org/report">le rapport</a>.</p>';
    const described = describeHtmlBody(html);

    expect(described).toContain("le rapport");
    expect(described).toContain("https://example.org/report");
  });

  it("adds no links block at all when the body carries none", () => {
    expect(describeHtmlBody("<p>Bonjour</p>")).not.toContain("Links it carries");
  });

  it("cuts a long body and says how many bytes are not shown", () => {
    const described = describeHtmlBody(`<p>${"a".repeat(MAX_PREVIEW_CHARS + 500)}</p>`);

    expect(described).toContain("[cut here: 500 more bytes of this body are not shown]");
    expect(described).not.toContain("a".repeat(MAX_PREVIEW_CHARS + 1));
  });

  it("cuts a long list of links and says how many are left", () => {
    const links = Array.from(
      { length: MAX_LINKS + 5 },
      (_, index) => `<a href="https://example.org/${index}">x</a>`,
    ).join("");
    const described = describeHtmlBody(links);

    expect(described).toContain(`https://example.org/${MAX_LINKS - 1}`);
    expect(described).not.toContain(`https://example.org/${MAX_LINKS}"`);
    expect(described).toContain("and 5 more not shown");
  });
});

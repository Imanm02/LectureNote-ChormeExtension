import assert from "node:assert/strict";

const ARIA_REFERENCE_ATTRIBUTES = [
  "aria-activedescendant",
  "aria-controls",
  "aria-describedby",
  "aria-labelledby",
  "aria-owns",
];

function describeElement(element) {
  const id = element.getAttribute("id")?.trim();
  return id ? `${element.localName}#${id}` : element.localName;
}

function referenceIds(element, attribute) {
  return (element.getAttribute(attribute) ?? "").trim().split(/\s+/u).filter(Boolean);
}

function hasTextReference(element, documentValue) {
  const references = referenceIds(element, "aria-labelledby");
  return references.length > 0 && references.some((id) => documentValue.getElementById(id)?.textContent.trim());
}

function hasAccessibleLabel(element, documentValue) {
  if (element.getAttribute("aria-label")?.trim() || hasTextReference(element, documentValue)) {
    return true;
  }
  if (element.closest("label")) {
    return true;
  }
  const id = element.getAttribute("id")?.trim();
  return Boolean(id && [...documentValue.querySelectorAll("label[for]")].some(
    (label) => label.getAttribute("for") === id,
  ));
}

export function validateHtmlAccessibility(documentValue, htmlFile) {
  const ids = new Set();
  for (const element of documentValue.querySelectorAll("[id]")) {
    const id = element.getAttribute("id").trim();
    assert.ok(id, `${htmlFile} has an empty ID`);
    assert.ok(!ids.has(id), `${htmlFile} has a duplicate ID: ${id}`);
    ids.add(id);
  }

  for (const element of documentValue.querySelectorAll("*")) {
    for (const attribute of ARIA_REFERENCE_ATTRIBUTES) {
      for (const id of referenceIds(element, attribute)) {
        assert.ok(
          ids.has(id),
          `${htmlFile} ${describeElement(element)} has a missing ${attribute} target: ${id}`,
        );
      }
    }
  }

  for (const label of documentValue.querySelectorAll("label[for]")) {
    const targetId = label.getAttribute("for")?.trim();
    assert.ok(targetId, `${htmlFile} has a label with an empty for attribute`);
    const target = documentValue.getElementById(targetId);
    assert.ok(target, `${htmlFile} has a label for a missing control: ${targetId}`);
    assert.match(
      target.localName,
      /^(?:button|input|meter|output|progress|select|textarea)$/u,
      `${htmlFile} label target is not a form control: ${targetId}`,
    );
  }

  for (const control of documentValue.querySelectorAll("input, select, textarea")) {
    if (
      control.hidden
      || control.getAttribute("type")?.toLowerCase() === "hidden"
      || control.closest("template")
    ) {
      continue;
    }
    assert.ok(
      hasAccessibleLabel(control, documentValue),
      `${htmlFile} ${describeElement(control)} needs an accessible label`,
    );
  }

  for (const button of documentValue.querySelectorAll("button")) {
    if (button.closest("template")) {
      continue;
    }
    assert.ok(
      button.textContent.trim()
        || button.getAttribute("aria-label")?.trim()
        || hasTextReference(button, documentValue),
      `${htmlFile} ${describeElement(button)} needs an accessible name`,
    );
  }

  for (const link of documentValue.querySelectorAll('a[target="_blank"]')) {
    const rel = new Set((link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/u));
    assert.ok(
      rel.has("noreferrer") || rel.has("noopener"),
      `${htmlFile} ${describeElement(link)} opens a tab without a safe rel value`,
    );
  }
}

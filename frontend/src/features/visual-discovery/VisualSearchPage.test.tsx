import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { baseRoutes, product, withStore } from "@/features/shopping-assistant/test-fixtures";
import { mockApi, renderWithProviders } from "@/tests/test-utils";

import { validateImageFile } from "./validate";
import VisualSearchPage from "./VisualSearchPage";

describe("validateImageFile", () => {
  it("accepts JPEG/PNG/WebP up to 5 MB and rejects others", () => {
    expect(validateImageFile({ name: "a.jpg", type: "image/jpeg", size: 1000 })).toBeNull();
    expect(validateImageFile({ name: "a.webp", type: "image/webp", size: 5 * 1024 * 1024 })).toBeNull();
    expect(validateImageFile({ name: "a.gif", type: "image/gif", size: 1000 })).toMatch(/not a supported image/);
    expect(validateImageFile({ name: "big.png", type: "image/png", size: 6 * 1024 * 1024 })).toMatch(/limit is 5 MB/);
  });
});

describe("VisualSearchPage", () => {
  beforeEach(() => localStorage.clear());

  it("rejects an unsupported file without calling the API", async () => {
    const spy = mockApi(baseRoutes);
    renderWithProviders(withStore(<VisualSearchPage />), { route: "/shop/visual" });
    const input = await screen.findByTestId("photo-input");
    fireEvent.change(input, { target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("“notes.txt” is not a supported image");
    expect(spy.mock.calls.some(([url]) => String(url).includes("/visual-search"))).toBe(false);
  });

  it("uploads a valid photo and shows similarity matches with the method explanation", async () => {
    const spy = mockApi([
      ...baseRoutes,
      {
        method: "POST",
        path: "/visual-search",
        body: {
          matches: [product({ id: "tea", name: "Tata Tea Premium 500 g", visual_similarity: 0.992 })],
          method: "colour_layout_similarity",
          method_description: "Matched by colour histogram and coarse layout.",
          caption: null,
          image: { width: 480, height: 480 },
        },
      },
    ]);
    renderWithProviders(withStore(<VisualSearchPage />), { route: "/shop/visual" });
    // Wait until the store is selected so the upload can run.
    await screen.findByText("FreshMart Andheri West");
    fireEvent.change(screen.getByTestId("photo-input"), { target: { files: [new File([new Uint8Array(10)], "tea.jpg", { type: "image/jpeg" })] } });

    expect(await screen.findByText("99% match")).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Tata Tea Premium 500 g" })).toBeInTheDocument();
    expect(screen.getByText(/this is not object recognition/)).toBeInTheDocument();
    const call = spy.mock.calls.find(([url]) => String(url).includes("/visual-search"));
    const form = call![1]!.body as FormData;
    expect(form.get("store_id")).toBe("s1");
    expect((form.get("image") as File).name).toBe("tea.jpg");
  });
});

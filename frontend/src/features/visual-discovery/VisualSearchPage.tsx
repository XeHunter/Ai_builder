import { useMutation } from "@tanstack/react-query";
import { Camera, ImageUp, RotateCcw, ScanSearch } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/data";
import { Callout, EmptyState, ErrorState } from "@/components/ui/feedback";
import { useShopperStore } from "@/hooks/use-stores";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { VisualSearchResponse } from "@/types/api";
import { ProductGrid, ProductGridSkeleton, ProductTile } from "@/features/shopping-assistant/components/ProductTile";

import { ACCEPTED_TYPES, validateImageFile } from "./validate";

export default function VisualSearchPage() {
  const { store, storeId } = useShopperStore();
  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<string | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const pickRef = React.useRef<HTMLInputElement>(null);
  const cameraRef = React.useRef<HTMLInputElement>(null);

  const search = useMutation({
    mutationFn: (f: File) => {
      const form = new FormData();
      form.append("store_id", storeId ?? "");
      form.append("image", f);
      return api.upload<VisualSearchResponse>("/visual-search", form);
    },
  });

  React.useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    if (typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const accept = (f: File | undefined | null) => {
    if (!f) return;
    const err = validateImageFile(f);
    setFileError(err);
    if (err) return;
    setFile(f);
    search.reset();
    if (storeId) search.mutate(f);
  };

  const reset = () => {
    setFile(null);
    setFileError(null);
    search.reset();
  };

  const data = search.data;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={store?.name}
        title="Photo search"
        description="Upload or take a photo of a product and we'll find similar items in this store, with price, stock and shelf location."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Your photo</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                accept(e.dataTransfer.files?.[0]);
              }}
              className={cn(
                "flex min-h-56 flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-4 text-center transition-colors",
                dragging ? "border-primary bg-primary-soft" : "border-border-strong bg-surface-raised",
              )}
            >
              {preview ? (
                <img src={preview} alt="Selected product photo" className="max-h-64 rounded-md object-contain" />
              ) : (
                <>
                  <ImageUp className="size-8 text-muted-foreground" aria-hidden />
                  <p className="text-sm">
                    <span className="font-medium">Drag a photo here</span> or choose one below
                  </p>
                  <p className="text-xs text-muted-foreground">JPEG, PNG or WebP · up to 5 MB</p>
                </>
              )}
            </div>
            {fileError && (
              <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
                {fileError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => pickRef.current?.click()} variant={file ? "outline" : "default"}>
                <ImageUp aria-hidden /> {file ? "Choose another photo" : "Choose a photo"}
              </Button>
              <Button variant="outline" onClick={() => cameraRef.current?.click()}>
                <Camera aria-hidden /> Take a photo
              </Button>
              {file && (
                <Button variant="ghost" onClick={reset}>
                  <RotateCcw aria-hidden /> Clear
                </Button>
              )}
            </div>
            <input
              ref={pickRef}
              type="file"
              accept={ACCEPTED_TYPES.join(",")}
              className="sr-only"
              aria-label="Upload a product photo"
              data-testid="photo-input"
              onChange={(e) => {
                accept(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              aria-label="Take a product photo with your camera"
              tabIndex={-1}
              onChange={(e) => {
                accept(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <Callout title="No photo handy?">
              Sample product photos are included in the repository under <code className="font-mono text-xs">data/sample/query_images</code>.
            </Callout>
          </CardContent>
        </Card>

        <section aria-labelledby="matches-title" className="space-y-4">
          <h2 id="matches-title" className="text-lg font-semibold">
            Matches
          </h2>
          {search.isPending ? (
            <ProductGridSkeleton count={4} />
          ) : search.isError ? (
            <ErrorState error={search.error} onRetry={file ? () => search.mutate(file) : undefined} />
          ) : data ? (
            <>
              {data.caption ? (
                <Callout title="What we see">
                  {data.caption} <span className="block text-xs text-muted-foreground">{data.method_description}</span>
                </Callout>
              ) : (
                <Callout tone="simulated" title="Colour & layout similarity">
                  {data.method_description} Results show products whose packaging looks alike — this is not object recognition.
                </Callout>
              )}
              {data.matches.length ? (
                <ProductGrid className="sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3">
                  {data.matches.map((m) => (
                    <ProductTile
                      key={m.id}
                      product={m}
                      badge={
                        m.visual_similarity != null ? (
                          <Badge variant="primary" className="bg-surface/95 shadow-sm">
                            {Math.round(m.visual_similarity * 100)}% match
                          </Badge>
                        ) : undefined
                      }
                    />
                  ))}
                </ProductGrid>
              ) : (
                <EmptyState icon={ScanSearch} title="No similar products found" description="Try a closer, well-lit photo of the front of the pack." />
              )}
            </>
          ) : (
            <EmptyState icon={ScanSearch} title="Upload a photo to see matches" description="We compare your photo with product images from this store's catalog." />
          )}
        </section>
      </div>
    </div>
  );
}

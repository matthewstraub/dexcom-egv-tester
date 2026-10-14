import { trpc } from "@/lib/trpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, httpLink, splitLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient();

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    console.error("[API Mutation Error]", error);
  }
});

const linkOptions = {
  url: "/api/trpc",
  transformer: superjson,
  async fetch(input: RequestInfo | URL, init?: RequestInit) {
    const response = await globalThis.fetch(input, {
      ...(init ?? {}),
      credentials: "include",
    });
    // The server answers 401 once a session expires; send the browser back
    // through sign-in instead of leaving the page full of failed queries.
    if (response.status === 401) {
      const here = window.location.pathname + window.location.search;
      window.location.assign(`/login?next=${encodeURIComponent(here)}`);
    }
    return response;
  },
};

const trpcClient = trpc.createClient({
  links: [
    // A batch is answered only when every call in it is done. Live readings can
    // wait on a Dexcom Share sign-in, so they travel alone and never hold up
    // the rest of the page.
    splitLink({
      condition: (op) => op.path === "dexcom.latest",
      true: httpLink(linkOptions),
      false: httpBatchLink(linkOptions),
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);

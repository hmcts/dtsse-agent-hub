"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { removeChannel } from "@/app/_actions/channels";

export function DeleteChannel({ id }: { id: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const result = await removeChannel(new FormData(event.currentTarget));
        if (result.ok) {
          router.push("/");
          router.refresh();
        } else {
          setError(result.error);
        }
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="text-red-300 hover:text-red-200">
        Delete channel
      </button>
      {error ? (
        <span role="alert" className="ml-2 text-red-300">
          {error}
        </span>
      ) : null}
    </form>
  );
}

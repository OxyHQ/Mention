"use client";
import { LoadingSpinner } from "@/components/elements/loading-spinner";
import { TryAgain } from "@/components/elements/try-again";
import { ConnectHeader, PersonDetails } from "@/features/connect";
import { useUsers } from "@/features/profile";
import { useLocale } from "@/app/LocaleContext";

import type { IUser } from "@/features/profile";

export const ConnectClientPage = () => {
  const { t } = useLocale();
  const {
    data: people = [],
    isLoading,
    isError,
    error,
  } = useUsers({
    queryKey: ["people"],
    limit: 20,
  });

  if (isLoading) {
    return (
      <>
        <ConnectHeader />
        <LoadingSpinner />
      </>
    );
  }

  if (isError) {
    return (
      <>
        <ConnectHeader />
        <TryAgain />
        <p>{error.message}</p>
      </>
    );
  }

  return (
    <div
      style={{
        paddingBottom: "calc(100vh - 8rem)",
      }}
    >
      <ConnectHeader />
      <h2 className="px-4 py-3 text-h2 font-bold text-secondary-100">
        {t("pages.connect.suggestedPeople")}
      </h2>
      {people.length > 0 &&
        people?.map((person: IUser) => {
          return (
            <div key={person.id}>
              <PersonDetails IUser={person} />
            </div>
          );
        })}
    </div>
  );
};

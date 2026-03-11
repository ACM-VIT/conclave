import type { Metadata } from "next";
import DeleteAccountClient from "./delete-account-client";

export const metadata: Metadata = {
  title: "Delete Account",
};

export default function DeleteAccountPage() {
  return <DeleteAccountClient />;
}

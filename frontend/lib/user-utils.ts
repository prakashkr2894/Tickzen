/**
 * Shared user mapping utilities.
 * Previously duplicated identically in auth-context.tsx and data-context.tsx.
 */

export interface RawApiUser {
  _id?: string;
  id?: string;
  name: string;
  email: string;
  role?: string;
  avatar?: string;
  createdAt?: string;
}

export interface MappedUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: "admin" | "developer";
  avatar?: string;
  createdAt: string;
}

export const splitName = (name: string): { firstName: string; lastName: string } => {
  const parts = (name || "").trim().split(/\s+/);
  return {
    firstName: parts[0] || "User",
    lastName: parts.slice(1).join(" ") || "",
  };
};

export const mapApiUser = (user: RawApiUser): MappedUser => {
  const { firstName, lastName } = splitName(user.name);
  return {
    id: (user.id || user._id || "").toString(),
    email: user.email,
    firstName,
    lastName,
    role: user.role === "admin" ? "admin" : "developer",
    avatar: user.avatar,
    createdAt: user.createdAt || new Date().toISOString(),
  };
};

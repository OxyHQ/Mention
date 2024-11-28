import { useState } from "react";
import { Modal } from "@/components/elements/modal";
import { Button } from "../button";

interface FeedManagementModalProps {
  onClose: () => void;
}

export const FeedManagementModal = ({ onClose }: FeedManagementModalProps) => {
  const [newFeedName, setNewFeedName] = useState("");
  const [feeds, setFeeds] = useState<
    { id?: string; name: string; users: any[] }[]
  >([]);
  const [newUserName, setNewUserName] = useState("");
  const [selectedFeedIndex, setSelectedFeedIndex] = useState<number | null>(
    null,
  );

  const handleCreateOrUpdateFeed = async (feedId?: string) => {
    try {
      const response = await fetch("/api/feeds", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: feedId, name: newFeedName }),
      });
      if (!response.ok) {
        throw new Error("Error creating or updating feed");
      }
      const feed = (await response.json()) as { id: string; name: string };
      if (feedId) {
        setFeeds(
          feeds.map((f) => (f.id === feedId ? { ...f, name: feed.name } : f)),
        );
      } else {
        if (typeof feed === "object" && feed !== null) {
          if (feed && feed.name) {
            setFeeds([...feeds, { id: feed.id, name: feed.name, users: [] }]);
          } else {
            console.error("Feed is missing required properties:", feed);
          }
        } else {
          console.error("Feed is not an object:", feed);
        }
      }
      setNewFeedName("");
    } catch (error) {
      console.error("Error creating or updating feed:", error);
    }
  };

  const handleAddUser = async (feedIndex: number) => {
    if (newUserName.trim() === "") return;
    const updatedFeeds = [...feeds];
    updatedFeeds[feedIndex].users.push({ name: newUserName });
    setFeeds(updatedFeeds);
    setNewUserName("");
  };

  return (
    <Modal onClose={onClose} background="white">
      <div className="p-4">
        <h2 className="mb-4 text-xl font-bold">Manage Feeds</h2>
        <input
          type="text"
          value={newFeedName}
          onChange={(e) => setNewFeedName(e.target.value)}
          placeholder="New Feed Name"
          className="mb-4 w-full border p-2"
        />
        <Button onClick={() => handleCreateOrUpdateFeed()} className="mb-4">
          Create Feed
        </Button>
        <ul>
          {feeds.map((feed, index) => (
            <li key={index} className="mb-2">
              {feed.name}
              <input
                value={selectedFeedIndex === index ? newUserName : ""}
                onFocus={() => setSelectedFeedIndex(index)}
                onBlur={() => setSelectedFeedIndex(null)}
                onChange={(e) => setNewUserName(e.target.value)}
                placeholder="New User Name"
              />
              <Button onClick={() => handleAddUser(index)} className="ml-2">
                Add User
              </Button>
              <Button
                onClick={() => handleCreateOrUpdateFeed(feed.id)}
                className="ml-2"
              >
                Edit Feed
              </Button>
              <ul>
                {feed.users.map((user, userIndex) => (
                  <li key={userIndex} className="ml-4">
                    {user.name}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
};

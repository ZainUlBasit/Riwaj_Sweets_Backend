const UserDto = (user) => {
  const storeRef = user.store_id;
  const storeId =
    storeRef && typeof storeRef === "object" && storeRef._id
      ? storeRef._id
      : storeRef || null;
  const storeName =
    storeRef && typeof storeRef === "object" && storeRef.name
      ? storeRef.name
      : null;

  return {
    _id: user._id,
    name: user.name || user.fullName,
    email: user.email,
    role: user.role,
    store_id: storeId,
    store_name: storeName,
  };
};

module.exports = UserDto;

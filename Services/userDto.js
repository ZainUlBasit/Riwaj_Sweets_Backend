const UserDto = (user) => {
  return {
    _id: user._id,
    name: user.name || user.fullName,
    email: user.email,
    role: user.role,
  };
};

module.exports = UserDto;
